/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const PREFIX = "[dlxp:";
const SUFFIX = "]";

export interface ButtonShare {
    label: string;
    url: string;
    heart: boolean;
}

function to3y3(message: string) {
    return Array.from(message)
        .map(ch => ch.codePointAt(0) ?? 0)
        .filter(cp => cp >= 0x20 && cp <= 0x7f)
        .map(cp => String.fromCodePoint(cp + 0xe0000))
        .join("");
}

function hiddenAscii(text: string) {
    return Array.from(text)
        .map(ch => ch.codePointAt(0) ?? 0)
        .filter(cp => cp >= 0xe0020 && cp <= 0xe007f)
        .map(cp => String.fromCodePoint(cp - 0xe0000))
        .join("");
}

export function isHttpUrl(value: string) {
    return /^https?:\/\/\S+$/i.test(value.trim());
}

export function encodeShare(state: ButtonShare): string {
    const label = state.label.trim().slice(0, 32);
    const url = state.url.trim().slice(0, 256);
    if (!label || !isHttpUrl(url)) return "";
    const raw = JSON.stringify({ l: label, u: url, h: state.heart ? 1 : 0 });
    const b64 = btoa(unescape(encodeURIComponent(raw))).replace(/=+$/, "");
    return to3y3(`${PREFIX}${b64}${SUFFIX}`);
}

export function decodeShare(bio: string | undefined | null): ButtonShare | null {
    if (!bio) return null;
    const ascii = hiddenAscii(bio);
    const match = ascii.match(/\[dlxp:([A-Za-z0-9+/_-]+)\]/);
    if (!match) return null;
    try {
        const b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
        const parsed = JSON.parse(decodeURIComponent(escape(atob(padded)))) as { l?: string; u?: string; h?: number; };
        const label = String(parsed.l ?? "").trim().slice(0, 32);
        const url = String(parsed.u ?? "").trim().slice(0, 256);
        if (!label || !isHttpUrl(url)) return null;
        return { label, url, heart: parsed.h !== 0 };
    } catch {
        return null;
    }
}

export function stripShare(bio: string) {
    let out = "";
    let buf = "";
    let ascii = "";
    const flush = () => {
        if (!buf) return;
        if (ascii.includes(PREFIX)) {
            const cleaned = ascii.replace(/\[dlxp:[A-Za-z0-9+/=]*\]/g, "");
            out += to3y3(cleaned);
        } else {
            out += buf;
        }
        buf = "";
        ascii = "";
    };
    for (const ch of bio) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp >= 0xe0020 && cp <= 0xe007f) {
            buf += ch;
            ascii += String.fromCodePoint(cp - 0xe0000);
            continue;
        }
        flush();
        out += ch;
    }
    flush();
    return out;
}

export function writeShare(bio: string, state: ButtonShare | null) {
    const without = stripShare(bio);
    const encoded = state ? encodeShare(state) : "";
    if (!encoded) return without.trimEnd();
    const base = without.replace(/\s+$/g, "");
    return base ? `${base} ${encoded}` : encoded;
}
