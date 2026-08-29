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

export type AudioSource = "discord" | "system" | "mic";

export const SPECTRUM_BARS = 32;

const TARGET_SR = 16000;
const SPEECH_RMS = 0.012;
const SILENCE_MS = 700;
const MIN_SPEECH_MS = 450;
const MAX_UTTER_MS = 8000;

let fromLang = "auto";
let toLang = "en";
let audioSource: AudioSource = "discord";
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
let analyser: AnalyserNode | null = null;
let freqBytes: Uint8Array | null = null;
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

export function parseAudioSource(value: string): AudioSource {
    switch (value) {
        case "discord":
        case "system":
        case "mic":
            return value;
        default:
            return "discord";
    }
}

export function setAudioSource(source: AudioSource) {
    audioSource = source;
}

export function getAudioSource() {
    return audioSource;
}

export function fillSpectrum(out: Float32Array) {
    const node = analyser;
    const bins = freqBytes;
    const ctx = audioCtx;
    if (!listening || !node || !bins || !ctx) {
        for (let i = 0; i < out.length; i++) out[i] *= 0.78;
        return;
    }
    node.getByteFrequencyData(bins as Uint8Array);
    const sr = ctx.sampleRate || TARGET_SR;
    const binHz = sr / node.fftSize;
    const minHz = 70;
    const maxHz = Math.min(7000, sr * 0.48);
    const n = bins.length;
    for (let i = 0; i < out.length; i++) {
        const t0 = i / out.length;
        const t1 = (i + 1) / out.length;
        const f0 = minHz * Math.pow(maxHz / minHz, t0);
        const f1 = minHz * Math.pow(maxHz / minHz, t1);
        let i0 = Math.floor(f0 / binHz);
        let i1 = Math.ceil(f1 / binHz);
        if (i0 < 1) i0 = 1;
        if (i1 <= i0) i1 = i0 + 1;
        if (i1 > n) i1 = n;
        let sum = 0;
        for (let b = i0; b < i1; b++) sum += bins[b];
        const shaped = Math.pow(sum / ((i1 - i0) * 255), 0.7);
        out[i] = out[i] * 0.36 + shaped * 0.64;
    }
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
    try { analyser?.disconnect(); } catch { /* ignore */ }
    analyser = null;
    freqBytes = null;
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

type DesktopSource = {
    id: string;
    name: string;
    isDiscord?: boolean;
    isScreen?: boolean;
};

async function getMicStream() {
    return await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        },
        video: false
    });
}

async function listDesktopSources() {
    if (!Native) throw new Error("Native helper unavailable. Fully quit Discord from the tray, then reopen.");
    const res = await Native.listDesktopAudioSources();
    if (!res.ok) throw new Error(res.data);
    const sources = JSON.parse(res.data) as DesktopSource[];
    if (!Array.isArray(sources) || !sources.length) throw new Error("No desktop audio sources found");
    return sources;
}

async function captureDesktop(filter: (s: DesktopSource) => boolean, emptyMsg: string) {
    const sources = (await listDesktopSources()).filter(filter);
    if (!sources.length) throw new Error(emptyMsg);

    let lastError: unknown;
    for (const preferred of sources) {
        try {
            const stream = await (navigator.mediaDevices as any).getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: "desktop",
                        chromeMediaSourceId: preferred.id
                    }
                },
                video: {
                    mandatory: {
                        chromeMediaSource: "desktop",
                        chromeMediaSourceId: preferred.id,
                        maxWidth: 2,
                        maxHeight: 2
                    }
                }
            });
            for (const t of stream.getVideoTracks()) {
                t.stop();
                stream.removeTrack(t);
            }
            if (stream.getAudioTracks().length)
                return stream as MediaStream;
            for (const t of stream.getTracks()) t.stop();
            lastError = new Error(`No audio on ${preferred.name}`);
        } catch (e) {
            lastError = e;
        }
    }

    throw lastError instanceof Error ? lastError : new Error(emptyMsg);
}

async function getCaptureStream(source: AudioSource): Promise<{ stream: MediaStream; label: string; }> {
    switch (source) {
        case "mic":
            return { stream: await getMicStream(), label: "Microphone" };
        case "discord":
            try {
                return {
                    stream: await captureDesktop(
                        s => Boolean(s.isDiscord),
                        "No Discord window found. Keep this app open and try again."
                    ),
                    label: "Discord"
                };
            } catch (e) {
                const msg = String(e).replace(/^Error:\s*/, "");
                if (/no audio/i.test(msg))
                    throw new Error("Discord window has no audio. Use System audio to hear the call.");
                throw e instanceof Error ? e : new Error(msg);
            }
        case "system":
            return {
                stream: await captureDesktop(
                    s => Boolean(s.isScreen),
                    "No system audio source found."
                ),
                label: "System audio"
            };
        default: {
            const _: never = source;
            return _;
        }
    }
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
        const heard = await transcribePcm(pcm16, TARGET_SR, fromLang);
        const text = heard.text;
        if (!text) {
            setStatus(listening ? listenStatus() : "Ready");
            return;
        }
        lastOriginal = text;
        const detect = heard.language || (fromLang === "auto" ? "auto" : fromLang);
        let translated = text;
        try {
            const tr = await googleTranslate(text, detect, toLang);
            translated = tr.text || text;
        } catch {
            translated = text;
        }
        lastTranslation = translated;
        history.push({ original: text, translation: translated });
        if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
        schedulePersist();
        setStatus(listening ? listenStatus() : "Ready");
    } catch (e) {
        setStatus(String(e).slice(0, 80));
    } finally {
        partial = false;
        busyTranscribe = false;
    }
}

function listenStatus() {
    switch (audioSource) {
        case "discord":
            return "Listening to Discord";
        case "system":
            return "Listening to system audio";
        case "mic":
            return "Listening to microphone";
        default: {
            const _: never = audioSource;
            return _;
        }
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

    setStatus("Loading model…");
    listening = true;
    try {
        try {
            audioCtx = new AudioContext({ sampleRate: TARGET_SR });
        } catch {
            audioCtx = new AudioContext();
        }
        try { await audioCtx.resume(); } catch { /* ignore */ }

        await ensureWhisper();
        ready = true;
        if (audioCtx.state === "suspended") {
            try { await audioCtx.resume(); } catch { /* ignore */ }
        }
        setStatus("Starting capture…");
        const captured = await getCaptureStream(audioSource);
        activeStreams = [captured.stream];
        const src = audioCtx.createMediaStreamSource(captured.stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        analyser.minDecibels = -88;
        analyser.maxDecibels = -20;
        freqBytes = new Uint8Array(analyser.frequencyBinCount);
        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = onAudioProcess;
        const mute = audioCtx.createGain();
        mute.gain.value = 0;
        src.connect(analyser);
        src.connect(processor);
        processor.connect(mute);
        mute.connect(audioCtx.destination);

        setStatus(listenStatus());
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
