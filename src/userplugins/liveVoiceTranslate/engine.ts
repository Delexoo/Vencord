/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";

import { googleTranslate } from "./translate";
import { ensureWhisper, getWhisperLoadStatus, releaseWhisper, transcribePcm } from "./whisper";

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

const TARGET_SR = 16000;
const SPEECH_RMS = 0.0022;
const SILENCE_MS = 600;
const MIN_SPEECH_MS = 550;
const MAX_UTTER_MS = 8000;
const PREROLL_CHUNKS = 4;

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
let tapAnalyser: AnalyserNode | null = null;
let tapBuf: Float32Array<ArrayBuffer> | null = null;
let graphSrc: MediaStreamAudioSourceNode | null = null;
let graphPreamp: GainNode | null = null;
let graphSink: MediaStreamAudioDestinationNode | null = null;
let activeStreams: MediaStream[] = [];
let pcmBuf: Float32Array[] = [];
let preroll: Float32Array[] = [];
let speechStartedAt = 0;
let lastLoudAt = 0;
let inSpeech = false;
let busyTranscribe = false;
let loopTimer: number | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let historyLoaded = false;
let noiseRms = 0.003;
let heardPeak = 0;
let listenStartedAt = 0;
let quietHinted = false;

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
    try { graphSrc?.disconnect(); } catch { /* ignore */ }
    graphSrc = null;
    try { graphPreamp?.disconnect(); } catch { /* ignore */ }
    graphPreamp = null;
    try { tapAnalyser?.disconnect(); } catch { /* ignore */ }
    tapAnalyser = null;
    tapBuf = null;
    graphSink = null;
    try { void audioCtx?.close(); } catch { /* ignore */ }
    audioCtx = null;
    pcmBuf = [];
    preroll = [];
    inSpeech = false;
    level = 0;
    noiseRms = 0.003;
    heardPeak = 0;
    quietHinted = false;
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
    if (Math.abs(inputRate - TARGET_SR) < 1) return input;
    const ratio = inputRate / TARGET_SR;
    const outLen = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(outLen);
    const last = input.length - 1;
    for (let i = 0; i < outLen; i++) {
        const src = i * ratio;
        const i0 = Math.min(last, Math.floor(src));
        const i1 = Math.min(last, i0 + 1);
        const t = src - i0;
        out[i] = (input[i0] ?? 0) * (1 - t) + (input[i1] ?? 0) * t;
    }
    return out;
}

function normalizePcm(samples: Float32Array) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const a = Math.abs(samples[i]);
        if (a > peak) peak = a;
    }
    if (peak < 0.0006) return samples;
    const gain = Math.min(18, 0.72 / peak);
    if (gain < 1.05) return samples;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++)
        out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
    return out;
}

function attachCaptureGraph(stream: MediaStream) {
    if (!audioCtx) throw new Error("Audio is not ready");
    try { graphSrc?.disconnect(); } catch { /* ignore */ }
    try { graphPreamp?.disconnect(); } catch { /* ignore */ }
    try { tapAnalyser?.disconnect(); } catch { /* ignore */ }

    for (const s of activeStreams) {
        if (s === stream) continue;
        for (const t of s.getTracks()) {
            try { t.stop(); } catch { /* ignore */ }
        }
    }
    activeStreams = [stream];

    graphSrc = audioCtx.createMediaStreamSource(stream);
    graphPreamp = audioCtx.createGain();
    graphPreamp.gain.value = audioSource === "mic" ? 2.2 : 5;
    tapAnalyser = audioCtx.createAnalyser();
    tapAnalyser.fftSize = 2048;
    tapAnalyser.smoothingTimeConstant = 0;
    tapBuf = new Float32Array(tapAnalyser.fftSize);
    graphSink = audioCtx.createMediaStreamDestination();
    graphSrc.connect(graphPreamp);
    graphPreamp.connect(tapAnalyser);
    graphPreamp.connect(graphSink);
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
            } catch {
                return {
                    stream: await captureDesktop(
                        s => Boolean(s.isScreen),
                        "No Discord or system audio source found."
                    ),
                    label: "System audio"
                };
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
    if (busyTranscribe || !pcmBuf.length) return;
    const chunks = pcmBuf;
    pcmBuf = [];
    inSpeech = false;
    busyTranscribe = true;
    partial = true;
    setStatus("Transcribing…");
    try {
        const merged = normalizePcm(mergePcm(chunks));
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

function onPcmFrame(input: Float32Array) {
    if (!listening) return;
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / Math.max(1, input.length));
    level = rms;
    heardPeak = Math.max(heardPeak, rms);

    if (!inSpeech) {
        noiseRms = noiseRms * 0.96 + rms * 0.04;
        preroll.push(new Float32Array(input));
        if (preroll.length > PREROLL_CHUNKS) preroll.shift();
    }

    const now = Date.now();
    const gate = Math.max(SPEECH_RMS, noiseRms * 2.2);
    const loud = rms >= gate;

    if (loud) {
        lastLoudAt = now;
        if (!inSpeech) {
            inSpeech = true;
            speechStartedAt = now;
            pcmBuf = preroll.slice();
            preroll = [];
        } else {
            pcmBuf.push(new Float32Array(input));
        }
    } else if (inSpeech) {
        pcmBuf.push(new Float32Array(input));
    }

    if (inSpeech) {
        const elapsed = now - speechStartedAt;
        const silentFor = now - lastLoudAt;
        if (elapsed >= MAX_UTTER_MS || (silentFor >= SILENCE_MS && elapsed >= MIN_SPEECH_MS))
            void flushUtterance();
    }
}

function pumpCapture() {
    if (!listening || !tapAnalyser || !tapBuf) return;
    tapAnalyser.getFloatTimeDomainData(tapBuf as Float32Array<ArrayBuffer>);
    onPcmFrame(tapBuf);
}

export async function startListening() {
    if (listening) return;

    setStatus("Loading model…");
    listening = true;
    heardPeak = 0;
    quietHinted = false;
    listenStartedAt = Date.now();
    try {
        audioCtx = new AudioContext();
        try { await audioCtx.resume(); } catch { /* ignore */ }

        await ensureWhisper();
        ready = true;
        if (audioCtx.state === "suspended") {
            try { await audioCtx.resume(); } catch { /* ignore */ }
        }
        setStatus("Starting capture…");
        const captured = await getCaptureStream(audioSource);
        if (captured.label.startsWith("System") && audioSource === "discord") {
            audioSource = "system";
            setStatus("Using System audio");
        }
        attachCaptureGraph(captured.stream);

        setStatus(listenStatus());
        if (loopTimer != null) window.clearInterval(loopTimer);
        const hop = Math.max(80, Math.round((tapAnalyser?.fftSize || 2048) / (audioCtx.sampleRate || TARGET_SR) * 1000));
        loopTimer = window.setInterval(() => {
            if (!listening) return;
            if (audioCtx?.state === "suspended")
                void audioCtx.resume();
            pumpCapture();
            if (!quietHinted && Date.now() - listenStartedAt > 2500 && heardPeak < 0.001) {
                quietHinted = true;
                if (audioSource === "discord") {
                    audioSource = "system";
                    void (async () => {
                        try {
                            setStatus("Switching to System audio…");
                            const next = await getCaptureStream("system");
                            attachCaptureGraph(next.stream);
                            setStatus(listenStatus());
                        } catch {
                            setStatus("No speech heard — try Mic in Advanced");
                        }
                    })();
                } else {
                    setStatus("No speech heard — try another source in Advanced");
                }
            }
            if (inSpeech && Date.now() - lastLoudAt >= SILENCE_MS && Date.now() - speechStartedAt >= MIN_SPEECH_MS)
                void flushUtterance();
        }, hop);
    } catch (e) {
        listening = false;
        stopTracks();
        ready = getWhisperLoadStatus() === "ready";
        setStatus(String(e).replace(/^Error:\s*/, "").slice(0, 100));
        throw e;
    }
}

export async function stopListening(keepModel = false) {
    listening = false;
    if (loopTimer != null) {
        window.clearInterval(loopTimer);
        loopTimer = null;
    }
    if (inSpeech && pcmBuf.length) await flushUtterance();
    stopTracks();
    if (!keepModel) {
        ready = false;
        await releaseWhisper();
        setStatus("Off");
        return;
    }
    setStatus(ready ? "Ready" : "Off");
}

export function isListening() {
    return listening;
}
