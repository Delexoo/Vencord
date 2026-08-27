/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, shell, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

function presetsRoot() {
    const base = join(app.getPath("documents"), "AdvancedRichPresence", "presets");
    mkdirSync(base, { recursive: true });
    return base;
}

function safeName(fileName: string) {
    const base = fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
    if (!base.toLowerCase().endsWith(".md")) return `${base || "preset"}.md`;
    return base || "preset.md";
}

export async function getPresetsDir(_: IpcMainInvokeEvent) {
    try {
        return { ok: true, data: presetsRoot() };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function listPresetFiles(_: IpcMainInvokeEvent) {
    try {
        const dir = presetsRoot();
        const files = readdirSync(dir)
            .filter(f => f.toLowerCase().endsWith(".md"))
            .sort((a, b) => a.localeCompare(b));
        return { ok: true, data: JSON.stringify(files) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function readPresetFile(_: IpcMainInvokeEvent, fileName: string) {
    try {
        const full = join(presetsRoot(), safeName(fileName));
        if (!existsSync(full)) return { ok: false, data: "missing" };
        return { ok: true, data: readFileSync(full, "utf8") };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function writePresetFile(_: IpcMainInvokeEvent, fileName: string, content: string) {
    try {
        const full = join(presetsRoot(), safeName(fileName));
        writeFileSync(full, content ?? "", "utf8");
        return { ok: true, data: full };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function deletePresetFile(_: IpcMainInvokeEvent, fileName: string) {
    try {
        const full = join(presetsRoot(), safeName(fileName));
        if (existsSync(full)) unlinkSync(full);
        return { ok: true, data: full };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function openPresetsFolder(_: IpcMainInvokeEvent) {
    try {
        const dir = presetsRoot();
        await shell.openPath(dir);
        return { ok: true, data: dir };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function fileExists(_: IpcMainInvokeEvent, fileName: string) {
    try {
        return { ok: true, data: existsSync(join(presetsRoot(), safeName(fileName))) ? "1" : "0" };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}
