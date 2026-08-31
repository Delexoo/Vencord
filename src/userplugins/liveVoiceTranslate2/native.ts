/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, desktopCapturer, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function historyRoot() {
    const base = join(app.getPath("documents"), "LiveVoiceTranslate2");
    mkdirSync(base, { recursive: true });
    return base;
}

function historyPath() {
    return join(historyRoot(), "history.json");
}

function collectDiscordSourceIds() {
    const ids = new Set<string>();
    for (const win of BrowserWindow.getAllWindows()) {
        try {
            const fromWin = (win as { getMediaSourceId?: () => string; }).getMediaSourceId?.();
            if (fromWin) ids.add(fromWin);
        } catch { /* ignore */ }
        try {
            const fromWc = (win.webContents as { getMediaSourceId?: () => string; }).getMediaSourceId?.();
            if (fromWc) ids.add(fromWc);
        } catch { /* ignore */ }
    }
    return ids;
}

export async function listDesktopAudioSources(_: IpcMainInvokeEvent) {
    try {
        const discordIds = collectDiscordSourceIds();
        const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            fetchWindowIcons: false
        });
        const mapped = sources.map(s => {
            const id = String(s.id || "");
            const name = String(s.name || "");
            const isScreen = id.startsWith("screen:") || /^(Entire screen|Screen \d+)/i.test(name);
            const isDiscord = (!isScreen && discordIds.has(id))
                || (/discord|vesktop|armcord|webcord/i.test(name) && !isScreen);
            return { id, name, isDiscord, isScreen };
        });
        mapped.sort((a, b) =>
            Number(b.isDiscord) - Number(a.isDiscord)
            || Number(b.isScreen) - Number(a.isScreen)
        );
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

function envValue(name: string) {
    const fromProc = String(process.env[name] ?? "").trim();
    if (fromProc) return fromProc;
    const localApp = process.env.LOCALAPPDATA ?? "";
    const candidates = [
        join(homedir(), "OneDrive", "Desktop", "Vencord", ".env"),
        join(homedir(), "Desktop", "Vencord", ".env"),
        localApp ? join(localApp, "DelexooVencord", ".env") : "",
    ];
    for (const path of candidates) {
        if (!path || !existsSync(path)) continue;
        try {
            for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
                const line = raw.trim();
                if (!line.toUpperCase().startsWith(name.toUpperCase())) continue;
                const eq = line.indexOf("=");
                if (eq < 0) continue;
                const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
                if (value) return value;
            }
        } catch { /* ignore unreadable env files */ }
    }
    return "";
}

export async function readOpenRouterKey(_: IpcMainInvokeEvent) {
    try {
        return { ok: true, data: envValue("OPENROUTER_API_KEY") };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function transcribeOpenRouter(
    _: IpcMainInvokeEvent,
    apiKey: string,
    model: string,
    audioBase64: string,
    language: string
) {
    const key = String(apiKey || "").trim() || envValue("OPENROUTER_API_KEY");
    if (!key)
        return { ok: false, data: "OpenRouter key missing. Paste it in this plugin’s settings." };
    if (!audioBase64)
        return { ok: false, data: "No audio to transcribe." };

    const bytes = Buffer.from(audioBase64, "base64");
    const lang = String(language || "").trim();
    const modelId = model || "openai/gpt-4o-transcribe";
    const headers = {
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://github.com/Delexoo/Vencord",
        "X-OpenRouter-Title": "Live Translate (API)"
    };

    async function parseBody(res: Response) {
        const raw = await res.text();
        if (!res.ok) {
            let detail = `OpenRouter ${res.status}`;
            try {
                const err = JSON.parse(raw) as { error?: { message?: string; }; message?: string; };
                detail = err?.error?.message || err?.message || detail;
            } catch { /* keep status */ }
            return { ok: false as const, data: String(detail).slice(0, 160) };
        }
        try {
            const data = JSON.parse(raw) as { text?: string; };
            return { ok: true as const, data: String(data.text || "").trim() };
        } catch {
            return { ok: false as const, data: "OpenRouter sent a bad response." };
        }
    }

    try {
        const form = new FormData();
        form.append("model", modelId);
        form.append("temperature", "0");
        form.append("response_format", "json");
        if (lang && lang !== "auto") form.append("language", lang);
        form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "speech.wav");
        let parsed = await parseBody(await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
            method: "POST",
            headers,
            body: form
        }));
        if (!parsed.ok) {
            const payload: Record<string, unknown> = {
                model: modelId,
                temperature: 0,
                input_audio: { data: audioBase64, format: "wav" }
            };
            if (lang && lang !== "auto") payload.language = lang;
            parsed = await parseBody(await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            }));
        }
        return parsed;
    } catch (e) {
        const msg = String(e).replace(/^Error:\s*/, "");
        if (/failed to fetch|networkerror|enotfound|econnreset/i.test(msg))
            return { ok: false, data: "Can't reach OpenRouter. Check your internet, then fully quit Discord from the tray and reopen." };
        return { ok: false, data: msg.slice(0, 160) };
    }
}
