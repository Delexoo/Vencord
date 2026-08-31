/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type SpeechRec = {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string; }; }>; }) => void) | null;
    onerror: ((ev: { error?: string; }) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
};

function recognitionCtor(): (new () => SpeechRec) | null {
    const w = window as typeof window & { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec; };
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function speechLang(code: string | undefined) {
    switch (code) {
        case "tl": return "fil-PH";
        case "en": return "en-US";
        case "es": return "es-ES";
        case "fr": return "fr-FR";
        case "de": return "de-DE";
        case "zh": return "zh-CN";
        case "ja": return "ja-JP";
        case "ko": return "ko-KR";
        case "id": return "id-ID";
        default: return "";
    }
}

export function createSpeechRecognition(lang: string, hooks: {
    onFinal: (text: string) => void;
    onPartial: (text: string) => void;
    onLevel: (level: number) => void;
    shouldRestart: () => boolean;
    onError: (msg: string) => void;
}) {
    const Ctor = recognitionCtor();
    if (!Ctor) throw new Error("This Discord build has no speech recognition. Use Live Translate (API) with a key.");
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = speechLang(lang);
    rec.onresult = ev => {
        let interim = "";
        let finalText = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const row = ev.results[i];
            const piece = String(row?.[0]?.transcript || "").trim();
            if (!piece) continue;
            if (row?.isFinal) finalText = finalText ? `${finalText} ${piece}` : piece;
            else interim = interim ? `${interim} ${piece}` : piece;
        }
        if (interim) {
            hooks.onLevel(0.08);
            hooks.onPartial(interim);
        }
        if (finalText) {
            hooks.onLevel(0.12);
            hooks.onFinal(finalText);
        }
    };
    rec.onerror = ev => {
        const err = String(ev?.error || "");
        if (err === "no-speech" || err === "aborted") return;
        if (err === "not-allowed") hooks.onError("Microphone permission denied");
        else if (err) hooks.onError(err);
    };
    rec.onend = () => {
        if (!hooks.shouldRestart()) return;
        try { rec.start(); } catch { /* ignore */ }
    };
    return rec;
}
