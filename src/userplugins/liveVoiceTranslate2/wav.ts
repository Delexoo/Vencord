/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function toInt16(pcm: Float32Array) {
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

function writeAscii(view: DataView, offset: number, text: string) {
    for (let i = 0; i < text.length; i++)
        view.setUint8(offset + i, text.charCodeAt(i));
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
