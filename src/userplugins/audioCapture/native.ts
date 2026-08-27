/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, desktopCapturer, dialog, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";

function defaultCapturesDir() {
    const videos = join(homedir(), "Videos", "AudioCapture");
    const fallback = join(homedir(), "Documents", "AudioCapture");
    try {
        mkdirSync(videos, { recursive: true });
        return videos;
    } catch {
        mkdirSync(fallback, { recursive: true });
        return fallback;
    }
}

export async function getDefaultRecordDir(_: IpcMainInvokeEvent) {
    try {
        return { ok: true, data: defaultCapturesDir() };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function ensureDir(_: IpcMainInvokeEvent, dir: string) {
    try {
        if (!dir) return { ok: false, data: "empty path" };
        mkdirSync(dir, { recursive: true });
        return { ok: true, data: dir };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function pickFolder(_: IpcMainInvokeEvent) {
    try {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const result = await dialog.showOpenDialog(win ?? undefined as any, {
            title: "Audio capture folder",
            properties: ["openDirectory", "createDirectory"],
            defaultPath: defaultCapturesDir()
        });
        if (result.canceled || !result.filePaths[0])
            return { ok: false, data: "" };
        return { ok: true, data: result.filePaths[0] };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function listDesktopAudioSources(_: IpcMainInvokeEvent) {
    try {
        const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            fetchWindowIcons: false
        });
        const mapped = sources.map(s => {
            const id = String(s.id || "");
            const name = String(s.name || "");
            const isScreen = id.startsWith("screen:") || /^(Entire screen|Screen \d+)/i.test(name);
            const isDiscord = /discord/i.test(name) && !isScreen;
            return { id, name, isDiscord, isScreen };
        });
        // Prefer Discord windows, then screens (screen capture carries system/loopback audio on Windows)
        mapped.sort((a, b) =>
            Number(b.isDiscord) - Number(a.isDiscord) ||
            Number(b.isScreen) - Number(a.isScreen)
        );
        return { ok: true, data: JSON.stringify(mapped) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function writeRecording(
    _: IpcMainInvokeEvent,
    dir: string,
    fileName: string,
    base64Data: string
) {
    try {
        if (!dir || !fileName) return { ok: false, data: "missing path" };
        mkdirSync(dir, { recursive: true });
        const safe = fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
        const root = resolve(dir);
        const full = resolve(root, safe);
        const rootPrefix = root.endsWith(sep) ? root.toLowerCase() : (root + sep).toLowerCase();
        if (!full.toLowerCase().startsWith(rootPrefix) && full.toLowerCase() !== root.toLowerCase())
            return { ok: false, data: "bad path" };
        writeFileSync(full, Buffer.from(base64Data, "base64"));
        return { ok: true, data: full };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function getUserDataPath(_: IpcMainInvokeEvent) {
    try {
        return { ok: true, data: app.getPath("userData") };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function pathExists(_: IpcMainInvokeEvent, p: string) {
    return { ok: true, data: existsSync(p) ? "1" : "0" };
}
