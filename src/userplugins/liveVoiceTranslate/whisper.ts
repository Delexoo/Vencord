/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type AsrResult = { text?: string; language?: string; };
type AsrPipeline = (audio: { raw: Float32Array; sampling_rate: number; }, opts?: Record<string, unknown>) => Promise<AsrResult | AsrResult[]>;

let pipelinePromise: Promise<AsrPipeline> | null = null;
let loadStatus = "idle";

export function getWhisperLoadStatus() {
    return loadStatus;
}

const TRANSFORMERS_JS = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.js";
const TRANSFORMERS_WASM = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/";

async function loadPipeline(): Promise<AsrPipeline> {
    loadStatus = "loading";
    const mod: any = await import(
        /* webpackIgnore: true */
        TRANSFORMERS_JS
    );
    const lib = mod?.pipeline ? mod : (mod?.default ?? mod);
    const { pipeline, env } = lib;
    if (typeof pipeline !== "function")
        throw new Error("Whisper library failed to load");
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    try {
        if (env.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.wasmPaths = TRANSFORMERS_WASM;
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
): Promise<{ text: string; language?: string; }> {
    if (!samples.length) return { text: "" };
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
    const rows = Array.isArray(result) ? result : [result];
    const text = rows.map(r => r.text || "").join(" ").trim();
    const detected = rows.find(r => r.language)?.language;
    return { text, language: detected };
}
