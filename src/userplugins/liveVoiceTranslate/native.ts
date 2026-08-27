/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, desktopCapturer, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

function historyRoot() {
    const base = join(app.getPath("documents"), "LiveVoiceTranslate");
    mkdirSync(base, { recursive: true });
    return base;
}

function historyPath() {
    return join(historyRoot(), "history.json");
}

export async function listDesktopAudioSources(_: IpcMainInvokeEvent) {
    try {
        const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            fetchWindowIcons: false
        });
        const mapped = sources.map(s => ({
            id: s.id,
            name: s.name,
            isDiscord: /discord/i.test(s.name)
        }));
        mapped.sort((a, b) => Number(b.isDiscord) - Number(a.isDiscord));
        return { ok: true, data: JSON.stringify(mapped) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function readHistory(_: IpcMainInvokeEvent) {
    try {
        const full = historyPath();
        if (!existsSync(full)) return { ok: true, data: "" };
        return { ok: true, data: readFileSync(full, "utf8") };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function writeHistory(_: IpcMainInvokeEvent, json: string) {
    try {
        const full = historyPath();
        writeFileSync(full, json ?? "", "utf8");
        return { ok: true, data: full };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function getHistoryDir(_: IpcMainInvokeEvent) {
    try {
        return { ok: true, data: historyRoot() };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}
