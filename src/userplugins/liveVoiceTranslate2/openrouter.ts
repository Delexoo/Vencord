/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

import { encodeWav } from "./wav";

export type OpenRouterSttModel = "openai/gpt-4o-transcribe" | "openai/whisper-1";

const Native = VencordNative.pluginHelpers["LiveVoiceTranslate (API)"] as PluginNative<typeof import("./native")> | undefined;

function openaiLang(code: string | undefined) {
    if (!code || code === "auto") return "";
    return code;
}

function toBase64(bytes: Uint8Array) {
    const chunk = 0x8000;
    let bin = "";
    for (let i = 0; i < bytes.length; i += chunk)
        bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
    return btoa(bin);
}

export async function transcribeOpenRouter(
    samples: Float32Array,
    sampleRate: number,
    apiKey: string,
    model: OpenRouterSttModel,
    language?: string
): Promise<{ text: string; }> {
    const key = apiKey.trim();
    if (!key) throw new Error("OpenRouter key missing. Paste it in this plugin’s settings.");
    if (samples.length < sampleRate * 1.0) return { text: "" };
    if (!Native?.transcribeOpenRouter)
        throw new Error("Restart Discord from the tray so OpenRouter can run.");

    const wav = encodeWav(samples, sampleRate);
    const res = await Native.transcribeOpenRouter(key, model, toBase64(wav), openaiLang(language));
    if (!res?.ok) throw new Error(String(res?.data || "OpenRouter failed").slice(0, 140));
    return { text: String(res.data || "").trim() };
}
