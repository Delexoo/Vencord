/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const LANG_NAMES: Record<string, string> = {
    auto: "Auto",
    en: "English",
    tl: "Tagalog",
    fil: "Tagalog",
    tgl: "Tagalog",
    es: "Spanish",
    fr: "French",
    de: "German",
    zh: "Chinese",
    ja: "Japanese",
    ko: "Korean",
    id: "Indonesian",
    pt: "Portuguese",
    it: "Italian",
    ru: "Russian",
    vi: "Vietnamese",
    th: "Thai",
    ar: "Arabic",
    hi: "Hindi",
    nl: "Dutch",
    pl: "Polish",
    tr: "Turkish",
    uk: "Ukrainian",
    ms: "Malay",
    bn: "Bengali",
    ur: "Urdu",
    fa: "Persian",
    sv: "Swedish",
    da: "Danish",
    fi: "Finnish",
    no: "Norwegian",
    cs: "Czech",
    ro: "Romanian",
    hu: "Hungarian",
    el: "Greek",
    he: "Hebrew",
    iw: "Hebrew"
};

export function normalizeLangCode(code: string | undefined | null) {
    const raw = String(code || "").trim().toLowerCase().replace(/_/g, "-");
    if (!raw || raw === "auto" || raw === "und") return "";
    if (raw === "fil" || raw === "tgl" || raw === "tl-ph") return "tl";
    if (raw.startsWith("zh")) return "zh";
    return raw.split("-")[0] || "";
}

export function languageName(code: string | undefined | null) {
    const normalized = normalizeLangCode(code);
    if (!normalized) return "";
    return LANG_NAMES[normalized] || normalized.toUpperCase();
}

function foldText(text: string | undefined | null) {
    return String(text || "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function sameSpokenText(a: string | undefined | null, b: string | undefined | null) {
    const x = foldText(a);
    const y = foldText(b);
    return Boolean(x && y && x === y);
}

const HALLUCINATION = /^(thanks for watching|thank you for watching|please subscribe|please like and subscribe|subtitles by|transcript by|you|bye bye bye|the end)$/i;

function repeatingUnit(parts: string[], size: number) {
    if (parts.length < size * 4) return false;
    const unit = parts.slice(0, size);
    let covered = 0;
    for (let i = 0; i + size <= parts.length; i += size) {
        for (let j = 0; j < size; j++) {
            if (parts[i + j] !== unit[j]) return covered >= parts.length * 0.85 && covered / size >= 4;
        }
        covered += size;
    }
    return covered >= parts.length * 0.85 && covered / size >= 4;
}

export function isJunkTranscript(text: string | undefined | null) {
    const folded = foldText(text);
    if (!folded) return true;
    if (HALLUCINATION.test(folded)) return true;
    const parts = folded.split(" ");
    if (parts.length < 5) return false;
    const counts = new Map<string, number>();
    for (const part of parts) counts.set(part, (counts.get(part) ?? 0) + 1);
    let top = 0;
    for (const n of counts.values()) if (n > top) top = n;
    if (top >= 5 && top / parts.length >= 0.6) return true;
    return repeatingUnit(parts, 1) || repeatingUnit(parts, 2) || repeatingUnit(parts, 3) || repeatingUnit(parts, 4);
}

export function languagePairLabel(
    fromCode: string | undefined | null,
    toCode: string | undefined | null,
    original?: string | undefined | null,
    translation?: string | undefined | null
) {
    let from = normalizeLangCode(fromCode);
    const to = normalizeLangCode(toCode);
    if (sameSpokenText(original, translation))
        from = to || from;
    if (from && to && from === to) return languageName(from);
    const fromName = languageName(from);
    const toName = languageName(to);
    if (fromName && toName && fromName !== toName) return `${fromName} → ${toName}`;
    if (fromName) return fromName;
    if (toName) return toName;
    return "Spoken";
}
