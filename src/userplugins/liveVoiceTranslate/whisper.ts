/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type AsrResult = { text?: string; language?: string; };
type AsrPipeline = (
    audio: Float32Array | { raw: Float32Array; sampling_rate: number; },
    opts?: Record<string, unknown>
) => Promise<AsrResult | AsrResult[]>;

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

export async function releaseWhisper() {
    const pending = pipelinePromise;
    pipelinePromise = null;
    loadStatus = "idle";
    if (!pending) return;
    try {
        const asr: any = await pending;
        if (typeof asr?.dispose === "function") await asr.dispose();
    } catch { /* ignore */ }
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
    const minSamples = sampleRate;
    const audio = samples.length >= minSamples ? samples : new Float32Array(minSamples);
    if (audio !== samples) audio.set(samples);
    const secs = audio.length / sampleRate;
    const opts: Record<string, unknown> = {
        return_timestamps: false,
        task: "transcribe"
    };
    if (lang) opts.language = lang;
    if (secs > 12) {
        opts.chunk_length_s = 20;
        opts.stride_length_s = 3;
    }

    const parse = (result: AsrResult | AsrResult[]) => {
        const rows = Array.isArray(result) ? result : [result];
        const text = rows
            .map(r => String(r?.text || ""))
            .join(" ")
            .replace(/\[(?:blank_audio|silence|music|noise|inaudible)\]/gi, " ")
            .replace(/\((?:blank_audio|silence|music|noise)\)/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
        const detected = rows.find(r => r?.language)?.language;
        return { text, language: detected };
    };

    try {
        const first = parse(await asr(audio, { ...opts, sampling_rate: sampleRate }));
        if (first.text) return first;
        return parse(await asr({ raw: audio, sampling_rate: sampleRate }, opts));
    } catch {
        return parse(await asr({ raw: audio, sampling_rate: sampleRate }, opts));
    }
}
