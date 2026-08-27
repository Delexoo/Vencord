/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Mp3Encoder } from "./lame.js";

export const RECORD_FORMATS = ["wav", "mp3", "ogg", "flac", "m4a", "webm", "aiff"] as const;
export type RecordFormat = typeof RECORD_FORMATS[number];

const PCM_FORMATS = ["wav", "mp3", "ogg", "flac", "aiff"] as const;
type PcmFormat = typeof PCM_FORMATS[number];

export const FORMAT_OPTIONS: { label: string; value: RecordFormat; default?: boolean; }[] = [
    { label: "WAV (uncompressed)", value: "wav", default: true },
    { label: "MP3", value: "mp3" },
    { label: "OGG (Opus)", value: "ogg" },
    { label: "FLAC", value: "flac" },
    { label: "M4A (AAC)", value: "m4a" },
    { label: "WebM (Opus)", value: "webm" },
    { label: "AIFF", value: "aiff" },
];

export function isRecordFormat(value: string): value is RecordFormat {
    return (RECORD_FORMATS as readonly string[]).includes(value);
}

export function isPcmFormat(value: string): value is PcmFormat {
    return (PCM_FORMATS as readonly string[]).includes(value);
}

export function normalizeFormat(value: string | undefined): RecordFormat {
    return value && isRecordFormat(value) ? value : "wav";
}

export function recorderMimeFor(format: "webm" | "m4a"): string | null {
    const candidates = format === "m4a"
        ? ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/aac", "audio/x-m4a"]
        : ["audio/webm;codecs=opus", "audio/webm"];
    for (const mime of candidates) {
        try {
            if (MediaRecorder.isTypeSupported(mime)) return mime;
        } catch { /* ignore */ }
    }
    return null;
}

export function concatPcm(chunks: Float32Array[]): Float32Array {
    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
    }
    return samples;
}

export async function encodePcmRecording(
    format: PcmFormat,
    chunks: Float32Array[],
    sampleRate: number
): Promise<{ bytes: Uint8Array; ext: string; }> {
    const pcm = concatPcm(chunks);
    switch (format) {
        case "wav":
            return { bytes: encodeWav(pcm, sampleRate), ext: "wav" };
        case "aiff":
            return { bytes: encodeAiff(pcm, sampleRate), ext: "aiff" };
        case "mp3":
            return { bytes: await encodeMp3(pcm, sampleRate), ext: "mp3" };
        case "ogg":
            return { bytes: await encodeOggOpus(pcm, sampleRate), ext: "ogg" };
        case "flac":
            return { bytes: await encodeFlac(pcm, sampleRate), ext: "flac" };
        default: {
            const exhaustive: never = format;
            throw new Error(`Unsupported format: ${String(exhaustive)}`);
        }
    }
}

function toInt16(pcm: Float32Array): Int16Array {
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

function writeAscii(view: DataView, offset: number, text: string) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
    const samples = toInt16(pcm);
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);
    let idx = 44;
    for (let i = 0; i < samples.length; i++, idx += 2)
        view.setInt16(idx, samples[i], true);
    return new Uint8Array(buffer);
}

function encodeAiff(pcm: Float32Array, sampleRate: number): Uint8Array {
    const samples = toInt16(pcm);
    const commSize = 18;
    const ssndSize = 8 + samples.length * 2;
    const formSize = 4 + 8 + commSize + 8 + ssndSize;
    const buffer = new ArrayBuffer(12 + 8 + commSize + 8 + ssndSize);
    const view = new DataView(buffer);
    writeAscii(view, 0, "FORM");
    view.setUint32(4, formSize, false);
    writeAscii(view, 8, "AIFF");
    writeAscii(view, 12, "COMM");
    view.setUint32(16, commSize, false);
    view.setUint16(20, 1, false);
    view.setUint32(22, samples.length, false);
    view.setUint16(26, 16, false);
    writeIeee80(view, 28, sampleRate);
    writeAscii(view, 38, "SSND");
    view.setUint32(42, ssndSize, false);
    view.setUint32(46, 0, false);
    view.setUint32(50, 0, false);
    let idx = 54;
    for (let i = 0; i < samples.length; i++, idx += 2)
        view.setInt16(idx, samples[i], false);
    return new Uint8Array(buffer);
}

function writeIeee80(view: DataView, offset: number, value: number) {
    const sign = value < 0 ? 0x8000 : 0;
    const abs = Math.abs(value);
    if (!abs || !Number.isFinite(abs)) {
        view.setUint16(offset, sign, false);
        view.setUint32(offset + 2, 0, false);
        view.setUint32(offset + 6, 0, false);
        return;
    }
    const exp = Math.floor(Math.log2(abs)) + 16383;
    const frac = abs / Math.pow(2, exp - 16383) - 1;
    const scaled = frac * 0x80000000;
    const hi = 0x80000000 | Math.floor(scaled);
    const lo = Math.floor((scaled - Math.floor(scaled)) * 0x100000000);
    view.setUint16(offset, sign | exp, false);
    view.setUint32(offset + 2, hi >>> 0, false);
    view.setUint32(offset + 6, lo >>> 0, false);
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const outLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const x = i * ratio;
        const i0 = Math.floor(x);
        const i1 = Math.min(i0 + 1, input.length - 1);
        const t = x - i0;
        out[i] = input[i0] * (1 - t) + input[i1] * t;
    }
    return out;
}

async function encodeMp3(pcm: Float32Array, sampleRate: number): Promise<Uint8Array> {
    try {
        return await encodeWithWebCodecs("mp3", pcm, sampleRate, 192000);
    } catch {
        return encodeMp3Lame(pcm, sampleRate);
    }
}

function lameRate(sampleRate: number) {
    const allowed = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
    if (allowed.includes(sampleRate)) return sampleRate;
    return Math.abs(sampleRate - 48000) < Math.abs(sampleRate - 44100) ? 48000 : 44100;
}

function encodeMp3Lame(pcm: Float32Array, sampleRate: number): Uint8Array {
    const rate = lameRate(sampleRate);
    const samples = toInt16(resampleLinear(pcm, sampleRate, rate));
    const encoder = new Mp3Encoder(1, rate, 192);
    const frame = 1152;
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < samples.length; i += frame) {
        const slice = samples.subarray(i, Math.min(i + frame, samples.length));
        const buf = encoder.encodeBuffer(slice);
        if (buf.length) {
            parts.push(new Uint8Array(buf));
            total += buf.length;
        }
    }
    const tail = encoder.flush();
    if (tail.length) {
        parts.push(new Uint8Array(tail));
        total += tail.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    if (!out.length) throw new Error("MP3 encoder produced no data");
    return out;
}

async function encodeFlac(pcm: Float32Array, sampleRate: number): Promise<Uint8Array> {
    return await encodeWithWebCodecs("flac", pcm, sampleRate, 0);
}

async function encodeOggOpus(pcm: Float32Array, sampleRate: number): Promise<Uint8Array> {
    const rate = 48000;
    const samples = resampleLinear(pcm, sampleRate, rate);
    const packets = await encodeOpusPackets(samples, rate);
    return muxOggOpus(packets, rate, samples.length);
}

type EncodedPacket = { data: Uint8Array; samples: number; };

async function encodeOpusPackets(pcm: Float32Array, sampleRate: number): Promise<EncodedPacket[]> {
    const packets = await encodeWithWebCodecsPackets("opus", pcm, sampleRate, 64000, Math.round(sampleRate * 0.02));
    const frameSamples = Math.round(sampleRate * 0.02);
    return packets.map((data, i) => ({
        data,
        samples: i === packets.length - 1
            ? Math.max(1, pcm.length - i * frameSamples)
            : frameSamples
    }));
}

async function encodeWithWebCodecs(
    codec: string,
    pcm: Float32Array,
    sampleRate: number,
    bitrate: number
): Promise<Uint8Array> {
    const packets = await encodeWithWebCodecsPackets(codec, pcm, sampleRate, bitrate);
    let total = 0;
    for (const p of packets) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of packets) {
        out.set(p, offset);
        offset += p.length;
    }
    if (!out.length) throw new Error(`${codec} encoder produced no data`);
    return out;
}

async function encodeWithWebCodecsPackets(
    codec: string,
    pcm: Float32Array,
    sampleRate: number,
    bitrate: number,
    frameSamples = 1024
): Promise<Uint8Array[]> {
    const Encoder = (globalThis as { AudioEncoder?: new (init: any) => any; }).AudioEncoder;
    const AudioDataCtor = (globalThis as { AudioData?: new (init: any) => any; }).AudioData;
    if (!Encoder || !AudioDataCtor) throw new Error("WebCodecs audio encoder is not available");

    const config: Record<string, unknown> = {
        codec,
        numberOfChannels: 1,
        sampleRate,
    };
    if (bitrate > 0) config.bitrate = bitrate;

    if (typeof Encoder.isConfigSupported === "function") {
        const support = await Encoder.isConfigSupported(config);
        if (support && support.supported === false)
            throw new Error(`${codec} is not supported`);
    }

    const packets: Uint8Array[] = [];
    let extra: Uint8Array | null = null;
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (err: unknown) => {
            if (settled) return;
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
        };
        const encoder = new Encoder({
            output(chunk: { byteLength: number; copyTo(dest: BufferSource): void; }, meta?: { decoderConfig?: { description?: BufferSource; }; }) {
                if (!extra && meta?.decoderConfig?.description) {
                    const desc = meta.decoderConfig.description;
                    extra = desc instanceof ArrayBuffer
                        ? new Uint8Array(desc.slice(0))
                        : new Uint8Array(desc as ArrayBufferView);
                }
                const buf = new Uint8Array(chunk.byteLength);
                chunk.copyTo(buf);
                packets.push(buf);
            },
            error: fail
        });
        try {
            encoder.configure(config);
            let ts = 0;
            for (let i = 0; i < pcm.length; i += frameSamples) {
                const slice = pcm.subarray(i, Math.min(i + frameSamples, pcm.length));
                const data = new AudioDataCtor({
                    format: "f32",
                    sampleRate,
                    numberOfChannels: 1,
                    timestamp: ts,
                    data: slice
                });
                ts += Math.round(slice.length / sampleRate * 1_000_000);
                encoder.encode(data);
                data.close?.();
            }
            void encoder.flush().then(() => {
                try { encoder.close(); } catch { /* ignore */ }
                if (!settled) {
                    settled = true;
                    resolve();
                }
            }).catch(fail);
        } catch (e) {
            fail(e);
        }
    });

    if (codec === "flac" && extra && packets[0] && !(packets[0][0] === 0x66 && packets[0][1] === 0x4c)) {
        const head = extra;
        const body = packets;
        let total = head.length;
        for (const p of body) total += p.length;
        const merged = new Uint8Array(total);
        merged.set(head, 0);
        let offset = head.length;
        for (const p of body) {
            merged.set(p, offset);
            offset += p.length;
        }
        return [merged];
    }
    return packets;
}

const OGG_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++)
            r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
        table[i] = r >>> 0;
    }
    return table;
})();

function oggCrc(bytes: Uint8Array) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++)
        crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) & 0xff) ^ bytes[i]]) >>> 0;
    return crc;
}

function opusHead(sampleRate: number, preSkip: number) {
    const buf = new Uint8Array(19);
    const view = new DataView(buf.buffer);
    writeAscii(view, 0, "OpusHead");
    buf[8] = 1;
    buf[9] = 1;
    view.setUint16(10, preSkip, true);
    view.setUint32(12, sampleRate, true);
    view.setInt16(16, 0, true);
    buf[18] = 0;
    return buf;
}

function opusTags() {
    const vendor = "AudioCapture";
    const buf = new Uint8Array(8 + 4 + vendor.length + 4);
    const view = new DataView(buf.buffer);
    writeAscii(view, 0, "OpusTags");
    view.setUint32(8, vendor.length, true);
    for (let i = 0; i < vendor.length; i++) buf[12 + i] = vendor.charCodeAt(i);
    view.setUint32(12 + vendor.length, 0, true);
    return buf;
}

function makeOggPage(
    packets: Uint8Array[],
    serial: number,
    pageSeq: number,
    granule: bigint,
    headerType: number
) {
    const segments: number[] = [];
    const bodyParts: Uint8Array[] = [];
    let bodyLen = 0;
    for (const packet of packets) {
        let remaining = packet.length;
        if (remaining === 0) {
            segments.push(0);
            continue;
        }
        while (remaining >= 255) {
            segments.push(255);
            remaining -= 255;
        }
        segments.push(remaining);
        bodyParts.push(packet);
        bodyLen += packet.length;
    }
    const headerLen = 27 + segments.length;
    const page = new Uint8Array(headerLen + bodyLen);
    const view = new DataView(page.buffer);
    writeAscii(view, 0, "OggS");
    page[4] = 0;
    page[5] = headerType;
    view.setUint32(6, Number(granule & 0xffffffffn), true);
    view.setUint32(10, Number((granule >> 32n) & 0xffffffffn), true);
    view.setUint32(14, serial >>> 0, true);
    view.setUint32(18, pageSeq >>> 0, true);
    view.setUint32(22, 0, true);
    page[26] = segments.length;
    page.set(segments, 27);
    let offset = headerLen;
    for (const part of bodyParts) {
        page.set(part, offset);
        offset += part.length;
    }
    view.setUint32(22, oggCrc(page), true);
    return page;
}

function muxOggOpus(packets: EncodedPacket[], sampleRate: number, pcmSamples: number) {
    const preSkip = 384;
    const serial = (Math.random() * 0xfffffffe + 1) >>> 0;
    const pages: Uint8Array[] = [
        makeOggPage([opusHead(sampleRate, preSkip)], serial, 0, 0n, 0x02),
        makeOggPage([opusTags()], serial, 1, 0n, 0)
    ];
    let pageSeq = 2;
    let granule = BigInt(preSkip);
    const grouped: Uint8Array[] = [];
    let groupedSamples = 0;
    const flush = (eos: boolean) => {
        if (!grouped.length) return;
        granule += BigInt(groupedSamples);
        if (eos) granule = BigInt(preSkip + pcmSamples);
        pages.push(makeOggPage(grouped.splice(0), serial, pageSeq++, granule, eos ? 0x04 : 0));
        groupedSamples = 0;
    };
    for (let i = 0; i < packets.length; i++) {
        grouped.push(packets[i].data);
        groupedSamples += packets[i].samples;
        const last = i === packets.length - 1;
        if (grouped.length >= 48 || last) flush(last);
    }
    flush(true);
    let total = 0;
    for (const page of pages) total += page.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const page of pages) {
        out.set(page, offset);
        offset += page.length;
    }
    return out;
}
