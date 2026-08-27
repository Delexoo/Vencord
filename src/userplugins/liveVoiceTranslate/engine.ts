/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";

import { googleTranslate } from "./translate";
import { ensureWhisper, getWhisperLoadStatus, transcribePcm } from "./whisper";

const Native = VencordNative.pluginHelpers.LiveVoiceTranslate as PluginNative<typeof import("./native")> | undefined;

const HISTORY_KEY = "LiveVoiceTranslateHistory";
const MAX_HISTORY = 40;

export type HistoryRow = { original: string; translation: string; };

type PersistPayload = {
    history: HistoryRow[];
    original: string;
    translation: string;
};

export type EngineSnapshot = {
    ready: boolean;
    listening: boolean;
    status: string;
    level: number;
    original: string;
    translation: string;
    partial: boolean;
    detect: string;
    target: string;
    history: HistoryRow[];
};

const TARGET_SR = 16000;
const SPEECH_RMS = 0.012;
const SILENCE_MS = 700;
const MIN_SPEECH_MS = 450;
const MAX_UTTER_MS = 8000;

let fromLang = "tl";
let toLang = "en";
let listening = false;
let ready = false;
let status = "Ready";
let level = 0;
let history: HistoryRow[] = [];
let lastOriginal = "";
let lastTranslation = "";
let partial = false;

let audioCtx: AudioContext | null = null;
let processor: ScriptProcessorNode | null = null;
let activeStreams: MediaStream[] = [];
let pcmBuf: Float32Array[] = [];
let speechStartedAt = 0;
let lastLoudAt = 0;
let inSpeech = false;
let busyTranscribe = false;
let loopTimer: number | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let historyLoaded = false;

function setStatus(s: string) {
    status = s;
}

function persistPayload(): PersistPayload {
    return {
        history: history.slice(-MAX_HISTORY),
        original: lastOriginal,
        translation: lastTranslation
    };
}

async function flushPersist() {
    const payload = persistPayload();
    try {
        await DataStore.set(HISTORY_KEY, payload);
    } catch { /* ignore */ }
    try {
        if (Native?.writeHistory)
            await Native.writeHistory(JSON.stringify(payload, null, 2));
    } catch { /* ignore */ }
}

function schedulePersist() {
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void flushPersist();
    }, 400);
}

function applyPayload(payload: PersistPayload | null | undefined) {
    if (!payload || !Array.isArray(payload.history)) return false;
    history = payload.history
        .filter(r => r && (r.original || r.translation))
        .map(r => ({
            original: String(r.original ?? ""),
            translation: String(r.translation ?? "")
        }))
        .slice(-MAX_HISTORY);
    lastOriginal = String(payload.original ?? "");
    lastTranslation = String(payload.translation ?? "");
    return true;
}

export async function loadPersistedHistory() {
    if (historyLoaded) return;
    historyLoaded = true;
    try {
        if (Native?.readHistory) {
            const res = await Native.readHistory();
            if (res?.ok && res.data) {
                try {
                    if (applyPayload(JSON.parse(res.data) as PersistPayload)) return;
                } catch { /* fall through */ }
            }
        }
    } catch { /* fall through */ }
    try {
        const fromDs = await DataStore.get<PersistPayload>(HISTORY_KEY);
        applyPayload(fromDs);
    } catch { /* ignore */ }
}

export async function savePersistedHistoryNow() {
    if (saveTimer != null) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    await flushPersist();
}

export function setLanguages(detect: string, target: string) {
    fromLang = detect || "auto";
    toLang = target || "en";
}

export function getSnapshot(): EngineSnapshot {
    return {
        ready,
        listening,
        status,
        level,
        original: lastOriginal,
        translation: lastTranslation,
        partial,
        detect: fromLang,
        target: toLang,
        history: history.slice(-12)
    };
}

export function clearHistory() {
    history = [];
    lastOriginal = "";
    lastTranslation = "";
    partial = false;
    schedulePersist();
}

function stopTracks() {
    for (const s of activeStreams) {
        for (const t of s.getTracks()) {
            try { t.stop(); } catch { /* ignore */ }
        }
    }
    activeStreams = [];
    try { processor?.disconnect(); } catch { /* ignore */ }
    processor = null;
    try { void audioCtx?.close(); } catch { /* ignore */ }
    audioCtx = null;
    pcmBuf = [];
    inSpeech = false;
    level = 0;
}

function mergePcm(chunks: Float32Array[]) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Float32Array(n);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
}

function downsampleTo16k(input: Float32Array, inputRate: number) {
    if (inputRate === TARGET_SR) return input;
    const ratio = inputRate / TARGET_SR;
    const outLen = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const idx = Math.floor(i * ratio);
        out[i] = input[idx] ?? 0;
    }
    return out;
}

async function getSystemAudioStream() {
    if (!Native) throw new Error("Native helper unavailable. Use Discord desktop");
    const res = await Native.listDesktopAudioSources();
    if (!res.ok) throw new Error(res.data);
    const sources = JSON.parse(res.data) as { id: string; name: string; isDiscord: boolean; }[];
    if (!sources.length) throw new Error("No desktop audio sources found");
    const preferred = sources.find(s => s.isDiscord) ?? sources[0];
    const stream = await (navigator.mediaDevices as any).getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: "desktop"
            }
        },
        video: {
            mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: preferred.id,
                maxWidth: 1,
                maxHeight: 1
            }
        }
    });
    for (const t of stream.getVideoTracks()) {
        t.stop();
        stream.removeTrack(t);
    }
    if (!stream.getAudioTracks().length)
        throw new Error("System/Discord audio not available");
    return stream as MediaStream;
}

async function flushUtterance() {
    if (busyTranscribe || !pcmBuf.length) {
        pcmBuf = [];
        return;
    }
    const chunks = pcmBuf;
    pcmBuf = [];
    inSpeech = false;
    busyTranscribe = true;
    partial = true;
    setStatus("Transcribing…");
    try {
        const merged = mergePcm(chunks);
        const rate = audioCtx?.sampleRate || TARGET_SR;
        const pcm16 = downsampleTo16k(merged, rate);
        const text = await transcribePcm(pcm16, TARGET_SR, fromLang);
        if (!text) {
            setStatus(listening ? "Listening" : "Ready");
            return;
        }
        lastOriginal = text;
        let translated = text;
        try {
            const tr = await googleTranslate(text, fromLang, toLang);
            translated = tr.text || text;
        } catch {
            translated = text;
        }
        lastTranslation = translated;
        history.push({ original: text, translation: translated });
        if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
        schedulePersist();
        setStatus(listening ? "Listening" : "Ready");
    } catch (e) {
        setStatus(String(e).slice(0, 80));
    } finally {
        partial = false;
        busyTranscribe = false;
    }
}

function onAudioProcess(ev: AudioProcessingEvent) {
    if (!listening) return;
    const input = ev.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / Math.max(1, input.length));
    level = rms;

    const now = Date.now();
    const loud = rms >= SPEECH_RMS;

    if (loud) {
        lastLoudAt = now;
        if (!inSpeech) {
            inSpeech = true;
            speechStartedAt = now;
            pcmBuf = [];
        }
    }

    if (inSpeech) {
        pcmBuf.push(new Float32Array(input));
        const elapsed = now - speechStartedAt;
        const silentFor = now - lastLoudAt;
        if (elapsed >= MAX_UTTER_MS || (silentFor >= SILENCE_MS && elapsed >= MIN_SPEECH_MS))
            void flushUtterance();
    }
}

export async function startListening() {
    if (listening) return;
    if (!Native) {
        setStatus("Needs Discord desktop app");
        ready = false;
        throw new Error("Native helper unavailable");
    }

    setStatus("Loading model…");
    listening = true;
    try {
        await ensureWhisper();
        ready = true;
        setStatus("Starting capture…");
        const stream = await getSystemAudioStream();
        activeStreams = [stream];
        audioCtx = new AudioContext();
        const src = audioCtx.createMediaStreamSource(stream);
        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = onAudioProcess;
        const mute = audioCtx.createGain();
        mute.gain.value = 0;
        src.connect(processor);
        processor.connect(mute);
        mute.connect(audioCtx.destination);

        setStatus("Listening");
        if (loopTimer != null) window.clearInterval(loopTimer);
        loopTimer = window.setInterval(() => {
            if (!listening) return;
            if (inSpeech && Date.now() - lastLoudAt >= SILENCE_MS && Date.now() - speechStartedAt >= MIN_SPEECH_MS)
                void flushUtterance();
        }, 200);
    } catch (e) {
        listening = false;
        stopTracks();
        ready = getWhisperLoadStatus() === "ready";
        setStatus(String(e).replace(/^Error:\s*/, "").slice(0, 100));
        throw e;
    }
}

export async function stopListening() {
    listening = false;
    if (loopTimer != null) {
        window.clearInterval(loopTimer);
        loopTimer = null;
    }
    if (inSpeech && pcmBuf.length) await flushUtterance();
    stopTracks();
    setStatus(ready ? "Ready" : "Off");
}

export function isListening() {
    return listening;
}
