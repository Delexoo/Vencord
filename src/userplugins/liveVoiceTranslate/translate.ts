/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export async function googleTranslate(text: string, sourceLang: string, targetLang: string) {
    const trimmed = text.trim();
    if (!trimmed) return { text: "", sourceLanguage: sourceLang };

    const src = sourceLang === "auto" || !sourceLang ? "auto" : sourceLang;
    const tgt = targetLang || "en";
    if (src !== "auto" && src === tgt)
        return { text: trimmed, sourceLanguage: src };

    const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
        "params.client": "gtx",
        "dataTypes": "TRANSLATION",
        "key": "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA",
        "query.sourceLanguage": src,
        "query.targetLanguage": tgt,
        "query.text": trimmed
    });

    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`Translate failed: ${res.status}`);

    const data = await res.json() as { sourceLanguage?: string; translation?: string; };
    return {
        text: data.translation || trimmed,
        sourceLanguage: data.sourceLanguage || src
    };
}
