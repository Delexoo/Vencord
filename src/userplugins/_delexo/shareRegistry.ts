/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";

import { unpackState, type ShareState } from "../badges/share";
import { isHttpUrl, type ButtonShare } from "../profileButton/share";
import { getOwnBadgeShare, getOwnButtonShare, setOwnBadgeShare, setOwnButtonShare } from "./liveShare";

const Native = VencordNative.pluginHelpers.DelexoShare as PluginNative<typeof import("../delexoShare/native")> | undefined;
const RAW_URL = "https://raw.githubusercontent.com/Delexoo/Vencord/main/src/userplugins/_delexo/shareRegistry.json";
const POLL_MS = 20000;

type Registry = {
    badges: Record<string, string>;
    buttons: Record<string, ButtonShare>;
};

let cache: Registry = { badges: {}, buttons: {} };
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refs = 0;

function bump() {
    setOwnBadgeShare(getOwnBadgeShare());
    setOwnButtonShare(getOwnButtonShare());
}

function parseButtons(raw: Record<string, unknown>) {
    const next: Record<string, ButtonShare> = {};
    for (const [id, value] of Object.entries(raw)) {
        if (!/^\d{16,22}$/.test(id) || !value || typeof value !== "object") continue;
        const item = value as { label?: unknown; url?: unknown; heart?: unknown; };
        const label = String(item.label ?? "").trim().slice(0, 32);
        const url = String(item.url ?? "").trim();
        if (!label || !isHttpUrl(url)) continue;
        next[id] = { label, url, heart: item.heart !== false };
    }
    return next;
}

function apply(raw: unknown) {
    const parsed = (raw && typeof raw === "object") ? raw as { badges?: unknown; buttons?: unknown; } : {};
    const badges: Record<string, string> = {};
    if (parsed.badges && typeof parsed.badges === "object") {
        for (const [id, hex] of Object.entries(parsed.badges as Record<string, unknown>)) {
            if (/^\d{16,22}$/.test(id) && typeof hex === "string" && /^[0-9a-f]+$/i.test(hex))
                badges[id] = hex.toLowerCase();
        }
    }
    cache = {
        badges,
        buttons: parsed.buttons && typeof parsed.buttons === "object"
            ? parseButtons(parsed.buttons as Record<string, unknown>)
            : {},
    };
    bump();
}

async function loadFromGithub() {
    if (Native?.fetchShareRegistry) {
        const res = await Native.fetchShareRegistry();
        if (res.ok && res.data) {
            apply(JSON.parse(res.data));
            return true;
        }
    }
    const res = await fetch(RAW_URL, { cache: "no-cache" });
    if (!res.ok) return false;
    apply(await res.json());
    return true;
}

export async function refreshShareRegistry() {
    try {
        await loadFromGithub();
    } catch {
        /* keep last cache */
    }
}

export function startShareRegistry() {
    refs++;
    if (refs > 1) return;
    void refreshShareRegistry();
    if (!pollTimer) pollTimer = setInterval(() => void refreshShareRegistry(), POLL_MS);
}

export function stopShareRegistry() {
    refs = Math.max(0, refs - 1);
    if (refs > 0) return;
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

export function registryBadgeShare(userId: string): ShareState | null {
    const hex = cache.badges[userId];
    if (!hex) return null;
    return unpackState(hex);
}

export function registryButtonShare(userId: string): ButtonShare | null {
    return cache.buttons[userId] ?? null;
}

export async function publishBadgeShare(userId: string, hex: string) {
    if (!Native?.publishShare || !userId) return;
    const res = await Native.publishShare("badges", userId, hex);
    if (res.ok && res.data) apply(JSON.parse(res.data));
}

export async function publishButtonShare(userId: string, data: ButtonShare | null) {
    if (!Native?.publishShare || !userId) return;
    const res = await Native.publishShare("buttons", userId, data ? JSON.stringify(data) : "");
    if (res.ok && res.data) apply(JSON.parse(res.data));
}
