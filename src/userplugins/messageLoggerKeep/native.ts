/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, shell, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

function logsRoot() {
    const dir = join(app.getPath("documents"), "MessageLogger");
    mkdirSync(dir, { recursive: true });
    return dir;
}

function safeFile(id: string) {
    const name = String(id ?? "").replace(/[^\w.-]/g, "_").slice(0, 80);
    return `${name || "message"}.md`;
}

function parseFrontmatter(text: string) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {} as Record<string, string>;
    const out: Record<string, string> = {};
    for (const line of m[1].split(/\r?\n/)) {
        const eq = line.indexOf(":");
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
            try { value = JSON.parse(value); } catch { /* keep raw */ }
        }
        out[key] = value;
    }
    return out;
}

export async function getLogsDir(_: IpcMainInvokeEvent) {
    try {
        return { ok: true, data: logsRoot() };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function writeLog(_: IpcMainInvokeEvent, messageId: string, content: string) {
    try {
        const full = join(logsRoot(), safeFile(messageId));
        writeFileSync(full, content ?? "", "utf8");
        return { ok: true, data: full };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function listLogs(_: IpcMainInvokeEvent) {
    try {
        const dir = logsRoot();
        const items = readdirSync(dir)
            .filter(f => f.toLowerCase().endsWith(".md"))
            .map(file => {
                let loggedAt = 0;
                let id = file.replace(/\.md$/i, "");
                let kind = "";
                try {
                    const meta = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
                    if (meta.messageId) id = meta.messageId;
                    if (meta.type) kind = meta.type;
                    const t = Date.parse(meta.loggedAt || "");
                    if (Number.isFinite(t)) loggedAt = t;
                } catch { /* ignore */ }
                return { file, id, kind, loggedAt };
            });
        return { ok: true, data: JSON.stringify(items) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function deleteLog(_: IpcMainInvokeEvent, messageId: string) {
    try {
        const full = join(logsRoot(), safeFile(messageId));
        if (existsSync(full)) unlinkSync(full);
        return { ok: true, data: full };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function purgeOlderThan(_: IpcMainInvokeEvent, cutoffMs: number) {
    try {
        const dir = logsRoot();
        let removed = 0;
        for (const file of readdirSync(dir)) {
            if (!file.toLowerCase().endsWith(".md")) continue;
            const full = join(dir, file);
            let loggedAt = 0;
            try {
                const meta = parseFrontmatter(readFileSync(full, "utf8"));
                const t = Date.parse(meta.loggedAt || "");
                if (Number.isFinite(t)) loggedAt = t;
            } catch { /* ignore */ }
            if (!loggedAt) {
                try {
                    loggedAt = statSync(full).mtimeMs;
                } catch { continue; }
            }
            if (loggedAt > 0 && loggedAt < cutoffMs) {
                unlinkSync(full);
                removed++;
            }
        }
        return { ok: true, data: String(removed) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function openLogsFolder(_: IpcMainInvokeEvent) {
    try {
        const dir = logsRoot();
        await shell.openPath(dir);
        return { ok: true, data: dir };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}
