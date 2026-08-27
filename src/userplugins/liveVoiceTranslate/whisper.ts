/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type AsrPipeline = (audio: { raw: Float32Array; sampling_rate: number; }, opts?: Record<string, unknown>) => Promise<{ text: string; } | { text: string; }[]>;

let pipelinePromise: Promise<AsrPipeline> | null = null;
let loadStatus = "idle";

export function getWhisperLoadStatus() {
    return loadStatus;
}

async function loadPipeline(): Promise<AsrPipeline> {
    loadStatus = "loading";
    // Load from CDN so the plugin stays self-contained (no SpyT / Python).
    const transformersCdn = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
    const mod: any = await import(
        /* webpackIgnore: true */
        transformersCdn
    );
    const { pipeline, env } = mod;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    try {
        if (env.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.proxy = false;
            env.backends.onnx.wasm.numThreads = 1;
        }
    } catch { /* ignore */ }

    const asr = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
        quantized: true
    }) as AsrPipeline;
    loadStatus = "ready";
    return asr;
}

export async function ensureWhisper() {
    if (!pipelinePromise) {
        pipelinePromise = loadPipeline().catch(err => {
            pipelinePromise = null;
            loadStatus = "error";
            throw err;
        });
    }
    return pipelinePromise;
}

/** Map UI codes to Whisper language codes where needed. */
function whisperLang(code: string | undefined) {
    if (!code || code === "auto") return undefined;
    if (code === "tl") return "tl";
    if (code === "zh") return "zh";
    return code;
}

export async function transcribePcm(
    samples: Float32Array,
    sampleRate: number,
    language?: string
) {
    if (!samples.length) return "";
    const asr = await ensureWhisper();
    const lang = whisperLang(language);
    const result = await asr(
        { raw: samples, sampling_rate: sampleRate },
        {
            chunk_length_s: 20,
            stride_length_s: 3,
            return_timestamps: false,
            ...(lang ? { language: lang, task: "transcribe" } : { task: "transcribe" })
        }
    );
    const text = Array.isArray(result) ? result.map(r => r.text).join(" ") : result.text;
    return (text || "").trim();
}
