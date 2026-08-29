/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CHOICE_GROUPS, TOGGLE_BADGES, type BadgeOption } from "./catalog";

const PREFIX = "[dlxb:";
const SUFFIX = "]";
const ZW_MARK = "\u2060";
const ZW0 = "\u200b";
const ZW1 = "\u200c";

function zwPayloadRe() {
    return /\u2060[\u200b\u200c]+\u2060/g;
}

export interface ShareState {
    contributor: boolean;
    choices: Record<string, string>;
    toggles: Record<string, boolean>;
}

export type ShareEncodeMode = "tags" | "zw";

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

function toZw(message: string) {
    let bits = "";
    for (const ch of message) {
        const n = ch.charCodeAt(0) & 0xff;
        for (let i = 7; i >= 0; i--) bits += (n >> i) & 1 ? ZW1 : ZW0;
    }
    return ZW_MARK + bits + ZW_MARK;
}

function fromZw(text: string) {
    let out = "";
    for (const chunk of text.match(zwPayloadRe()) ?? []) {
        const bits = chunk.slice(1, -1);
        for (let i = 0; i + 8 <= bits.length; i += 8) {
            let n = 0;
            for (let b = 0; b < 8; b++) {
                if (bits[i + b] === ZW1) n |= 1 << (7 - b);
            }
            if (n >= 0x20 && n <= 0x7f) out += String.fromCharCode(n);
        }
    }
    return out;
}

export function emptyShareState(): ShareState {
    return {
        contributor: false,
        choices: Object.fromEntries(CHOICE_GROUPS.map(group => [group.key, "off"])),
        toggles: Object.fromEntries(TOGGLE_BADGES.map(badge => [badge.id, false])),
    };
}

export function packState(state: ShareState): string {
    let n = 0n;
    if (state.contributor) n |= 1n;
    TOGGLE_BADGES.forEach((badge, i) => {
        if (state.toggles[badge.id]) n |= 1n << BigInt(1 + i);
    });
    const shift = 1 + TOGGLE_BADGES.length;
    CHOICE_GROUPS.forEach((group, gi) => {
        const value = state.choices[group.key];
        const idx = value && value !== "off"
            ? group.options.findIndex(option => option.id === value) + 1
            : 0;
        n |= BigInt(idx & 15) << BigInt(shift + gi * 4);
    });
    return n.toString(16);
}

export function unpackState(hex: string): ShareState {
    const state = emptyShareState();
    let n = 0n;
    try { n = BigInt(`0x${hex}`); } catch { return state; }
    if (n <= 0n) return state;
    state.contributor = (n & 1n) !== 0n;
    TOGGLE_BADGES.forEach((badge, i) => {
        state.toggles[badge.id] = (n & (1n << BigInt(1 + i))) !== 0n;
    });
    const shift = 1 + TOGGLE_BADGES.length;
    CHOICE_GROUPS.forEach((group, gi) => {
        const idx = Number((n >> BigInt(shift + gi * 4)) & 15n);
        state.choices[group.key] = idx > 0 ? (group.options[idx - 1]?.id ?? "off") : "off";
    });
    return state;
}

export function stateToOptions(state: ShareState): BadgeOption[] {
    const out: BadgeOption[] = [];
    for (const group of CHOICE_GROUPS) {
        const id = state.choices[group.key];
        const option = group.options.find(item => item.id === id);
        if (option) out.push(option);
    }
    for (const badge of TOGGLE_BADGES) {
        if (state.toggles[badge.id]) out.push(badge);
    }
    return out;
}

export function encodeShare(state: ShareState, mode: ShareEncodeMode = "tags"): string {
    const packed = packState(state);
    if (packed === "0") return "";
    const payload = `${PREFIX}${packed}${SUFFIX}`;
    switch (mode) {
        case "zw":
            return toZw(payload);
        case "tags":
            return to3y3(payload);
        default: {
            const _: never = mode;
            return _;
        }
    }
}

function hexFromText(text: string) {
    const match = text.match(/\[dlxb:([0-9a-f]+)\]/i);
    return match?.[1] ?? null;
}

export function decodeShare(bio: string | undefined | null): ShareState | null {
    if (!bio) return null;
    const hex = hexFromText(hiddenAscii(bio))
        ?? hexFromText(fromZw(bio))
        ?? hexFromText(bio);
    if (!hex) return null;
    return unpackState(hex);
}

export function writeShare(bio: string, state: ShareState, mode: ShareEncodeMode = "tags"): string {
    const without = stripShare(bio);
    const encoded = encodeShare(state, mode);
    if (!encoded) return without.trimEnd();
    const base = without.replace(/\s+$/g, "");
    return base ? `${base} ${encoded}` : encoded;
}

export function stripShare(bio: string): string {
    let out = "";
    let buf = "";
    let ascii = "";
    const flush = () => {
        if (!buf) return;
        if (ascii.includes(PREFIX)) {
            const cleaned = ascii.replace(/\[dlxb:[0-9a-f]+\]/gi, "");
            out += to3y3(cleaned);
        } else {
            out += buf;
        }
        buf = "";
        ascii = "";
    };
    for (const ch of bio.replace(zwPayloadRe(), "")) {
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
    return out.replace(/\[dlxb:[0-9a-f]+\]/gi, "");
}

export function shareHasAnything(state: ShareState) {
    if (state.contributor) return true;
    if (Object.values(state.toggles).some(Boolean)) return true;
    return Object.values(state.choices).some(value => value && value !== "off");
}
