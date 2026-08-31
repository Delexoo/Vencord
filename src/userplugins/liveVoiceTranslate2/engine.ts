/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";

import { isJunkTranscript, normalizeLangCode, sameSpokenText } from "../_delexo/langNames";
import { OpenRouterSttModel, transcribeOpenRouter } from "./openrouter";
import { googleTranslate } from "./translate";

const Native = VencordNative.pluginHelpers["LiveVoiceTranslate (API)"] as PluginNative<typeof import("./native")> | undefined;

const HISTORY_KEY = "LiveVoiceTranslate2History";
const MAX_HISTORY = 40;
const TARGET_SR = 16000;
const SPEECH_RMS = 0.008;
const SYSTEM_SPEECH_RMS = 0.018;
const SILENCE_MS = 1600;
const MIN_SPEECH_MS = 1800;
const SYSTEM_MIN_SPEECH_MS = 2200;
const MAX_UTTER_MS = 12000;
const PREROLL_CHUNKS = 6;
const MIN_UTTER_RMS = 0.006;
const SYSTEM_MIN_UTTER_RMS = 0.014;
const MIN_UTTER_SEC = 1.2;

export type HistoryRow = { original: string; translation: string; fromLang?: string; toLang?: string; };

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

let fromLang = "auto";
let toLang = "en";
let apiKey = "";
let model: OpenRouterSttModel = "openai/gpt-4o-transcribe";
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
let scriptNode: ScriptProcessorNode | null = null;
let scriptMute: GainNode | null = null;
let hpState = { x: 0, y: 0 };
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
let captureGen = 0;
let drainPromise: Promise<void> | null = null;

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
        .filter(r => r && (r.original || r.translation) && !isJunkTranscript(r.original) && !isJunkTranscript(r.translation))
        .map(r => ({
            original: String(r.original ?? ""),
            translation: String(r.translation ?? ""),
            fromLang: String(r.fromLang ?? "").trim() || undefined,
            toLang: String(r.toLang ?? "").trim() || undefined
        }))
        .slice(-MAX_HISTORY);
    lastOriginal = String(payload.original ?? "");
    lastTranslation = String(payload.translation ?? "");
    if (isJunkTranscript(lastOriginal)) lastOriginal = "";
    if (isJunkTranscript(lastTranslation)) lastTranslation = "";
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

export function setApiKey(key: string) {
    apiKey = String(key || "").trim();
}

export function hasApiKey() {
    return Boolean(apiKey);
}

export async function loadApiKeyFromEnv() {
    if (apiKey) return apiKey;
    try {
        const res = await Native?.readOpenRouterKey?.();
        if (res?.ok && res.data) apiKey = String(res.data).trim();
    } catch { /* ignore */ }
    return apiKey;
}

export function setModel(value: string) {
    model = value === "openai/whisper-1" || value === "whisper-1"
        ? "openai/whisper-1"
        : "openai/gpt-4o-transcribe";
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
        history: history.slice(-40)
    };
}

export function clearHistory() {
    history = [];
    lastOriginal = "";
    lastTranslation = "";
    partial = false;
    schedulePersist();
}

function stopCaptureGraph() {
    if (scriptNode) {
        scriptNode.onaudioprocess = null as unknown as ScriptProcessorNode["onaudioprocess"];
        try { scriptNode.disconnect(); } catch { /* ignore */ }
    }
    scriptNode = null;
    try { scriptMute?.disconnect(); } catch { /* ignore */ }
    scriptMute = null;
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
    level = 0;
}

function resetCaptureState() {
    pcmBuf = [];
    preroll = [];
    inSpeech = false;
    noiseRms = 0.003;
    heardPeak = 0;
    quietHinted = false;
    hpState = { x: 0, y: 0 };
}

function stopTracks() {
    stopCaptureGraph();
    resetCaptureState();
}

function idleStatus() {
    return listening ? listenStatus() : "Off";
}

function waitWhileBusy() {
    return new Promise<void>(resolve => {
        const tick = () => {
            if (!busyTranscribe) resolve();
            else window.setTimeout(tick, 40);
        };
        tick();
    });
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

function highpassFrame(input: Float32Array) {
    const out = new Float32Array(input.length);
    const a = 0.996;
    let x1 = hpState.x;
    let y1 = hpState.y;
    for (let i = 0; i < input.length; i++) {
        const x = input[i];
        const y = a * (y1 + x - x1);
        out[i] = y;
        x1 = x;
        y1 = y;
    }
    hpState = { x: x1, y: y1 };
    return out;
}

function mixFrame(buf: AudioBuffer) {
    const n = buf.length;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const mixed = new Float32Array(n);
    for (let i = 0; i < n; i++) mixed[i] = (ch0[i] + ch1[i]) * 0.5;
    return highpassFrame(mixed);
}

function normalizePcm(samples: Float32Array) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const a = Math.abs(samples[i]);
        if (a > peak) peak = a;
    }
    if (peak < 0.0008) return samples;
    const gain = Math.min(8, 0.85 / peak);
    if (gain < 1.04) return samples;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++)
        out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
    return out;
}

function attachCaptureGraph(stream: MediaStream) {
    if (!audioCtx) throw new Error("Audio is not ready");
    if (scriptNode) {
        scriptNode.onaudioprocess = null as unknown as ScriptProcessorNode["onaudioprocess"];
        try { scriptNode.disconnect(); } catch { /* ignore */ }
        scriptNode = null;
    }
    try { scriptMute?.disconnect(); } catch { /* ignore */ }
    scriptMute = null;
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
    hpState = { x: 0, y: 0 };

    graphSrc = audioCtx.createMediaStreamSource(stream);
    graphPreamp = audioCtx.createGain();
    graphPreamp.gain.value = audioSource === "mic" ? 1.35 : 1.12;
    tapAnalyser = audioCtx.createAnalyser();
    tapAnalyser.fftSize = 2048;
    tapAnalyser.smoothingTimeConstant = 0;
    tapBuf = new Float32Array(tapAnalyser.fftSize);
    graphSink = audioCtx.createMediaStreamDestination();
    scriptNode = audioCtx.createScriptProcessor(4096, 2, 1);
    scriptMute = audioCtx.createGain();
    scriptMute.gain.value = 0;
    graphSrc.connect(graphPreamp);
    graphPreamp.connect(tapAnalyser);
    graphPreamp.connect(graphSink);
    graphPreamp.connect(scriptNode);
    scriptNode.connect(scriptMute);
    scriptMute.connect(audioCtx.destination);
    scriptNode.onaudioprocess = ev => {
        if (!listening) return;
        onPcmFrame(mixFrame(ev.inputBuffer));
    };
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

function listenStatus() {
    switch (audioSource) {
        case "discord":
            return "OpenRouter listening to Discord";
        case "system":
            return "OpenRouter listening to system audio";
        case "mic":
            return "OpenRouter listening to microphone";
        default: {
            const _: never = audioSource;
            return _;
        }
    }
}

async function flushUtterance(sampleRate?: number, force = false) {
    if (busyTranscribe || !pcmBuf.length) return;
    const chunks = pcmBuf;
    pcmBuf = [];
    inSpeech = false;
    const rate = sampleRate || audioCtx?.sampleRate || TARGET_SR;
    let merged = mergePcm(chunks);
    const durationSec = merged.length / Math.max(1, rate);
    const minSec = force ? 0.4 : MIN_UTTER_SEC;
    if (durationSec < minSec) {
        setStatus(idleStatus());
        return;
    }
    busyTranscribe = true;
    partial = true;
    setStatus("Transcribing… this can take a few seconds");
    try {
        if (!apiKey) await loadApiKeyFromEnv();
        if (!apiKey) throw new Error("OpenRouter key missing. Put OPENROUTER_API_KEY in Desktop\\Vencord\\.env");
        merged = normalizePcm(merged);
        let energy = 0;
        for (let i = 0; i < merged.length; i++) energy += merged[i] * merged[i];
        const utterRms = Math.sqrt(energy / Math.max(1, merged.length));
        const minRms = audioSource === "system" ? SYSTEM_MIN_UTTER_RMS : MIN_UTTER_RMS;
        if (!force && utterRms < minRms) {
            setStatus(idleStatus());
            return;
        }
        if (force && utterRms < 0.002) {
            setStatus(idleStatus());
            return;
        }
        const pcm16 = downsampleTo16k(merged, rate);
        const heard = await transcribeOpenRouter(pcm16, TARGET_SR, apiKey, model, fromLang);
        const text = heard.text.trim();
        if (!text || isJunkTranscript(text) || sameSpokenText(text, lastOriginal) || sameSpokenText(text, lastTranslation)) {
            setStatus(idleStatus());
            return;
        }
        lastOriginal = text;
        lastTranslation = text;
        let spokenLang = "";
        setStatus("Translating…");
        try {
            const tr = await googleTranslate(text, "auto", toLang);
            lastTranslation = (tr.text || text).trim() || text;
            spokenLang = normalizeLangCode(tr.sourceLanguage) || spokenLang;
        } catch {
            lastTranslation = text;
        }
        if (sameSpokenText(text, lastTranslation))
            spokenLang = normalizeLangCode(toLang) || spokenLang;
        if (isJunkTranscript(lastTranslation)) {
            setStatus(idleStatus());
            return;
        }
        history.push({ original: text, translation: lastTranslation, fromLang: spokenLang, toLang });
        if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
        schedulePersist();
        setStatus(idleStatus());
    } catch (e) {
        const msg = String(e).replace(/^Error:\s*/, "");
        setStatus((/failed to fetch|networkerror/i.test(msg)
            ? "Can't reach OpenRouter. Fully quit Discord from the tray and reopen."
            : msg).slice(0, 120));
    } finally {
        partial = false;
        busyTranscribe = false;
    }
}

function shouldFlush(now: number) {
    if (!inSpeech) return false;
    const elapsed = now - speechStartedAt;
    const silentFor = now - lastLoudAt;
    const minSpeech = audioSource === "system" ? SYSTEM_MIN_SPEECH_MS : MIN_SPEECH_MS;
    if (elapsed >= MAX_UTTER_MS && silentFor >= 280) return true;
    return silentFor >= SILENCE_MS && elapsed >= minSpeech;
}

function onPcmFrame(input: Float32Array) {
    if (!listening) return;
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / Math.max(1, input.length));
    level = rms;
    heardPeak = Math.max(heardPeak, rms);

    if (!inSpeech) {
        noiseRms = noiseRms * 0.97 + rms * 0.03;
        preroll.push(new Float32Array(input));
        if (preroll.length > PREROLL_CHUNKS) preroll.shift();
    }

    const now = Date.now();
    const speechFloor = audioSource === "system" ? SYSTEM_SPEECH_RMS : SPEECH_RMS;
    const gate = Math.max(speechFloor, noiseRms * (audioSource === "system" ? 2.4 : 2.0));
    const loud = rms >= gate;

    if (loud) {
        lastLoudAt = now;
        if (!inSpeech) {
            inSpeech = true;
            speechStartedAt = now;
            pcmBuf = preroll.slice();
            preroll = [];
            setStatus("Waiting for the sentence to finish…");
        } else {
            pcmBuf.push(new Float32Array(input));
        }
    } else if (inSpeech) {
        pcmBuf.push(new Float32Array(input));
    }

    if (shouldFlush(now)) void flushUtterance();
}

function dropStream(stream: MediaStream | null | undefined) {
    if (!stream) return;
    for (const t of stream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
    }
}

export async function startListening() {
    if (drainPromise) await drainPromise;
    if (listening) return;
    if (!apiKey) await loadApiKeyFromEnv();
    if (!apiKey) throw new Error("OpenRouter key missing. Put OPENROUTER_API_KEY in Desktop\\Vencord\\.env");

    const gen = ++captureGen;
    setStatus("Starting capture…");
    listening = true;
    heardPeak = 0;
    quietHinted = false;
    listenStartedAt = Date.now();
    try {
        audioCtx = new AudioContext();
        try { await audioCtx.resume(); } catch { /* ignore */ }
        ready = true;
        const captured = await getCaptureStream(audioSource);
        if (gen !== captureGen || !listening) {
            dropStream(captured.stream);
            stopTracks();
            ready = false;
            return;
        }
        if (captured.label.startsWith("System") && audioSource === "discord")
            audioSource = "system";
        attachCaptureGraph(captured.stream);
        setStatus(listenStatus());
        if (loopTimer != null) window.clearInterval(loopTimer);
        loopTimer = window.setInterval(() => {
            if (gen !== captureGen || !listening) return;
            if (audioCtx?.state === "suspended")
                void audioCtx.resume();
            if (!quietHinted && Date.now() - listenStartedAt > 4000 && heardPeak < 0.001) {
                quietHinted = true;
                if (audioSource === "discord") {
                    audioSource = "system";
                    void (async () => {
                        try {
                            setStatus("Switching to System audio…");
                            const next = await getCaptureStream("system");
                            if (gen !== captureGen || !listening) {
                                dropStream(next.stream);
                                return;
                            }
                            attachCaptureGraph(next.stream);
                            setStatus(listenStatus());
                        } catch {
                            if (gen === captureGen && listening)
                                setStatus("No speech heard — try Mic in Advanced");
                        }
                    })();
                } else {
                    setStatus("No speech heard — try another source in Advanced");
                }
            }
            if (shouldFlush(Date.now())) void flushUtterance();
        }, 200);
    } catch (e) {
        if (gen !== captureGen) return;
        listening = false;
        stopTracks();
        ready = false;
        setStatus(String(e).replace(/^Error:\s*/, "").slice(0, 120));
        throw e;
    }
}

export async function stopListening(_keepModel = false) {
    captureGen++;
    listening = false;
    if (loopTimer != null) {
        window.clearInterval(loopTimer);
        loopTimer = null;
    }
    if (drainPromise) return drainPromise;

    const leftover = pcmBuf;
    const leftoverSpeech = leftover.length > 0;
    const rate = audioCtx?.sampleRate || TARGET_SR;
    preroll = [];
    inSpeech = false;
    pcmBuf = leftover;
    stopCaptureGraph();

    if (!busyTranscribe && !leftoverSpeech) {
        resetCaptureState();
        partial = false;
        ready = false;
        setStatus("Off");
        return;
    }

    drainPromise = (async () => {
        try {
            if (!/^(Transcribing|Translating)/.test(status))
                setStatus("Finishing…");
            await waitWhileBusy();
            if (pcmBuf.length) await flushUtterance(rate, true);
            await waitWhileBusy();
        } finally {
            resetCaptureState();
            partial = false;
            ready = false;
            drainPromise = null;
            if (/^(Off|Ready|Finishing|Transcribing|Translating|Waiting|OpenRouter listening)/.test(status))
                setStatus("Off");
        }
    })();
    return drainPromise;
}

export function isListening() {
    return listening;
}
