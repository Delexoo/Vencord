/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";

import { isJunkTranscript, normalizeLangCode, sameSpokenText } from "../_delexo/langNames";
import { createSpeechRecognition } from "./speech";
import { googleTranslate } from "./translate";

const Native = VencordNative.pluginHelpers["LiveVoiceTranslate (FREE)"] as PluginNative<typeof import("./native")> | undefined;

const HISTORY_KEY = "LiveVoiceTranslateHistory";
const MAX_HISTORY = 40;

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
let audioSource: AudioSource = "discord";
let listening = false;
let ready = false;
let status = "Ready";
let level = 0;
let history: HistoryRow[] = [];
let lastOriginal = "";
let lastTranslation = "";
let partial = false;
let lastCaptionRaw = "";
let captionStableAt = 0;
let captionTimer: number | null = null;
let rec: ReturnType<typeof createSpeechRecognition> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let historyLoaded = false;
let captionBusy = false;

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
            translation: String(r.translation ?? ""),
            fromLang: String(r.fromLang ?? "").trim() || undefined,
            toLang: String(r.toLang ?? "").trim() || undefined
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
        history: history.slice(-40)
    };
}

export function clearHistory() {
    history = [];
    lastOriginal = "";
    lastTranslation = "";
    lastCaptionRaw = "";
    partial = false;
    schedulePersist();
}

function cleanText(raw: string) {
    return String(raw || "")
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

async function commitHeard(text: string) {
    const original = cleanText(text);
    if (!original || isJunkTranscript(original) || sameSpokenText(original, lastOriginal)) return;
    lastOriginal = original;
    partial = true;
    setStatus("Translating…");
    let translated = original;
    let spokenLang = "";
    try {
        const tr = await googleTranslate(original, "auto", toLang);
        translated = cleanText(tr.text || original) || original;
        spokenLang = normalizeLangCode(tr.sourceLanguage) || spokenLang;
    } catch { /* keep original */ }
    if (sameSpokenText(original, translated))
        spokenLang = normalizeLangCode(toLang) || spokenLang;
    if (isJunkTranscript(translated)) {
        partial = false;
        setStatus(listening ? listenStatus() : "Ready");
        return;
    }
    lastTranslation = translated;
    history.push({ original, translation: translated, fromLang: spokenLang, toLang });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    partial = false;
    schedulePersist();
    setStatus(listening ? listenStatus() : "Ready");
}

function listenStatus() {
    switch (audioSource) {
        case "discord":
            return "Windows Live Captions (Discord / system)";
        case "system":
            return "Windows Live Captions (system audio)";
        case "mic":
            return "Listening to microphone";
        default: {
            const _: never = audioSource;
            return _;
        }
    }
}

function stopSpeech() {
    const current = rec;
    rec = null;
    try { current?.stop(); } catch { /* ignore */ }
}

function startMicSpeech() {
    rec = createSpeechRecognition(fromLang, {
        onFinal: text => void commitHeard(text),
        onPartial: text => {
            partial = true;
            lastOriginal = cleanText(text) || lastOriginal;
        },
        onLevel: v => { level = v; },
        shouldRestart: () => listening && audioSource === "mic" && rec != null,
        onError: msg => setStatus(msg)
    });
    rec.start();
}

async function pollCaptions() {
    if (!listening || captionBusy || audioSource === "mic") return;
    captionBusy = true;
    try {
        const res = await Native?.readLiveCaptions?.();
        if (!res?.ok) {
            if (res?.data) setStatus(String(res.data).slice(0, 100));
            return;
        }
        const text = cleanText(res.data);
        if (!text) {
            level = Math.max(0, level * 0.7);
            return;
        }
        if (text === lastCaptionRaw) {
            if (captionStableAt && Date.now() - captionStableAt > 2200 && text !== lastOriginal)
                await commitHeard(text);
            return;
        }
        lastCaptionRaw = text;
        captionStableAt = Date.now();
        level = 0.07;
        partial = true;
        lastOriginal = text;
        setStatus("Hearing captions…");
    } finally {
        captionBusy = false;
    }
}

export async function startListening() {
    if (listening) return;
    listening = true;
    ready = true;
    lastCaptionRaw = "";
    captionStableAt = 0;
    level = 0;
    try {
        if (audioSource === "mic") {
            setStatus("Starting microphone…");
            startMicSpeech();
            setStatus(listenStatus());
            return;
        }
        if (!Native?.startLiveCaptions)
            throw new Error("Native helper unavailable. Fully quit Discord from the tray, then reopen.");
        setStatus("Starting Windows Live Captions…");
        const started = await Native.startLiveCaptions();
        if (!listening) {
            stopSpeech();
            ready = false;
            return;
        }
        if (!started.ok) throw new Error(started.data);
        setStatus(listenStatus());
        if (captionTimer != null) window.clearInterval(captionTimer);
        captionTimer = window.setInterval(() => void pollCaptions(), 450);
    } catch (e) {
        listening = false;
        stopSpeech();
        ready = false;
        setStatus(String(e).replace(/^Error:\s*/, "").slice(0, 120));
        throw e;
    }
}

export async function stopListening(_keepModel = false) {
    listening = false;
    if (captionTimer != null) {
        window.clearInterval(captionTimer);
        captionTimer = null;
    }
    stopSpeech();
    partial = false;
    level = 0;
    ready = false;
    setStatus("Off");
}

export function isListening() {
    return listening;
}
