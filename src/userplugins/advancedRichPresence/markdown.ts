/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ActivityType } from "@vencord/discord-types/enums";

export const enum TimestampMode {
    NONE = 0,
    NOW = 1,
    TIME = 2,
    CUSTOM = 3,
}

export interface PresenceFields {
    appID?: string;
    appName?: string;
    details?: string;
    detailsURL?: string;
    state?: string;
    stateURL?: string;
    type?: ActivityType;
    streamLink?: string;
    timestampMode?: TimestampMode;
    startTime?: number;
    endTime?: number;
    imageBig?: string;
    imageBigURL?: string;
    imageBigTooltip?: string;
    imageSmall?: string;
    imageSmallURL?: string;
    imageSmallTooltip?: string;
    buttonOneText?: string;
    buttonOneURL?: string;
    buttonTwoText?: string;
    buttonTwoURL?: string;
    partySize?: number;
    partyMaxSize?: number;
    partyId?: string;
}

export interface PresencePreset extends PresenceFields {
    id: string;
    name: string;
    fileName: string;
    updatedAt: number;
    notes?: string;
}

export const FIELD_KEYS = [
    "appID",
    "appName",
    "details",
    "detailsURL",
    "state",
    "stateURL",
    "type",
    "streamLink",
    "timestampMode",
    "startTime",
    "endTime",
    "imageBig",
    "imageBigURL",
    "imageBigTooltip",
    "imageSmall",
    "imageSmallURL",
    "imageSmallTooltip",
    "buttonOneText",
    "buttonOneURL",
    "buttonTwoText",
    "buttonTwoURL",
    "partySize",
    "partyMaxSize",
    "partyId",
] as const satisfies readonly (keyof PresenceFields)[];

export function slugify(name: string) {
    const s = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
    return s || `preset-${Date.now().toString(36)}`;
}

export function newId() {
    return `arp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeYaml(value: string) {
    if (/[:#\n\r"']/.test(value) || value.startsWith(" ") || value.endsWith(" "))
        return JSON.stringify(value);
    return value;
}

export function serializePresetMarkdown(preset: PresencePreset): string {
    const lines = ["---"];
    lines.push(`id: ${escapeYaml(preset.id)}`);
    lines.push(`name: ${escapeYaml(preset.name)}`);
    lines.push(`updatedAt: ${preset.updatedAt}`);
    for (const key of FIELD_KEYS) {
        const v = preset[key];
        if (v === undefined || v === null || v === "") continue;
        if (typeof v === "number") lines.push(`${key}: ${v}`);
        else lines.push(`${key}: ${escapeYaml(String(v))}`);
    }
    lines.push("---");
    lines.push("");
    lines.push((preset.notes || "").trimEnd());
    lines.push("");
    return lines.join("\n");
}

function parseScalar(raw: string): string | number {
    const t = raw.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        try { return JSON.parse(t.startsWith("'") ? `"${t.slice(1, -1)}"` : t); } catch { return t.slice(1, -1); }
    }
    // Discord snowflakes are 17–19 digits; Number() rounds them and breaks App IDs.
    if (/^\d{16,}$/.test(t)) return t;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
}

export function parsePresetMarkdown(fileName: string, md: string): PresencePreset | null {
    const text = md.replace(/^\uFEFF/, "");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return null;
    const meta: Record<string, string | number> = {};
    for (const line of m[1].split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const val = parseScalar(line.slice(idx + 1));
        meta[key] = val;
    }
    const name = String(meta.name || fileName.replace(/\.md$/i, "") || "Untitled");
    const id = String(meta.id || slugify(name));
    const preset: PresencePreset = {
        id,
        name,
        fileName: fileName.toLowerCase().endsWith(".md") ? fileName : `${fileName}.md`,
        updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : Date.now(),
        notes: (m[2] || "").trim(),
    };
    for (const key of FIELD_KEYS) {
        if (meta[key] === undefined) continue;
        (preset as any)[key] = key === "appID" ? String(meta[key]) : meta[key];
    }
    return preset;
}

export function snapshotFields(store: PresenceFields): PresenceFields {
    const out: PresenceFields = {};
    for (const key of FIELD_KEYS) {
        const value = store[key];
        if (value === undefined || value === null || value === "") continue;
        (out as any)[key] = key === "appID" ? String(value) : value;
    }
    return out;
}

export function applyFields(target: PresenceFields, fields: PresenceFields) {
    for (const key of FIELD_KEYS) {
        const value = fields[key];
        if (value === undefined || value === null || value === "")
            delete (target as any)[key];
        else
            (target as any)[key] = key === "appID" ? String(value) : value;
    }
}

export function resolveTemplate(text: string | undefined, presetName?: string, userName?: string): string | undefined {
    if (!text) return text;
    try {
        const now = new Date();
        return text
            .split("{time}").join(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
            .split("{date}").join(now.toLocaleDateString())
            .split("{preset}").join(presetName || "")
            .split("{user}").join(userName || "");
    } catch {
        return text;
    }
}
