/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, shell, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const USERS_MAP = "_users.json";

function logsRoot() {
    const dir = join(app.getPath("documents"), "MessageLogger");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, ".cache"), { recursive: true });
    return dir;
}

function cacheRoot() {
    const dir = join(logsRoot(), ".cache");
    mkdirSync(dir, { recursive: true });
    return dir;
}

function channelCacheDir(channelId: string) {
    const dir = join(cacheRoot(), safeId(channelId));
    mkdirSync(dir, { recursive: true });
    return dir;
}

function cachePath(channelId: string, messageId: string) {
    return join(channelCacheDir(channelId), `${safeId(messageId)}.json`);
}

function safeId(value: string) {
    const id = String(value ?? "").replace(/[^\w-]/g, "_");
    return id || "unknown";
}

function safeUsername(name: string) {
    const next = String(name ?? "")
        .normalize("NFKC")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .trim()
        .slice(0, 80);
    return next || "unknown";
}

function userFilePath(name: string) {
    return join(logsRoot(), `${safeUsername(name)}.md`);
}

function readUsersMap(): Record<string, string> {
    try {
        const full = join(logsRoot(), USERS_MAP);
        if (!existsSync(full)) return {};
        const parsed = JSON.parse(readFileSync(full, "utf8"));
        return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
    } catch {
        return {};
    }
}

function writeUsersMap(map: Record<string, string>) {
    writeFileSync(join(logsRoot(), USERS_MAP), JSON.stringify(map, null, 2), "utf8");
}

function resolveUserFile(displayName: string, username: string, userId: string) {
    const id = safeId(userId);
    const label = String(displayName || username || id).trim() || id;
    const target = userFilePath(label);
    const map = readUsersMap();
    const mapped = map[id];
    if (mapped) {
        const previous = userFilePath(mapped);
        if (previous !== target && existsSync(previous) && !existsSync(target)) {
            try { renameSync(previous, target); } catch { /* keep target */ }
        }
    }
    if (map[id] !== safeUsername(label)) {
        map[id] = safeUsername(label);
        try { writeUsersMap(map); } catch { /* ignore */ }
    }
    return target;
}

export async function getLogsDir(_: IpcMainInvokeEvent) {
    try {
        return { ok: true, data: logsRoot() };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function appendUserLog(
    _: IpcMainInvokeEvent,
    displayName: string,
    username: string,
    userId: string,
    entry: string
) {
    try {
        const full = resolveUserFile(displayName, username, userId);
        const block = String(entry ?? "").trimEnd() + "\n\n";
        if (!existsSync(full)) {
            const title = String(displayName || username || userId).trim() || "unknown";
            const handle = username ? ` (@${username})` : "";
            writeFileSync(full, `# ${title}${handle}\n\nUser ID: ${userId}\n\n${block}`, "utf8");
        } else {
            writeFileSync(full, readFileSync(full, "utf8") + block, "utf8");
        }
        return { ok: true, data: full };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function saveCached(
    _: IpcMainInvokeEvent,
    channelId: string,
    messageId: string,
    json: string
) {
    try {
        const full = cachePath(channelId, messageId);
        const existed = existsSync(full);
        writeFileSync(full, json ?? "{}", "utf8");
        return { ok: true, data: JSON.stringify({ path: full, existed }) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function loadChannelCache(_: IpcMainInvokeEvent, channelId: string) {
    try {
        const dir = channelCacheDir(channelId);
        const items: unknown[] = [];
        for (const file of readdirSync(dir)) {
            if (!file.toLowerCase().endsWith(".json")) continue;
            try {
                items.push(JSON.parse(readFileSync(join(dir, file), "utf8")));
            } catch { /* skip bad file */ }
        }
        return { ok: true, data: JSON.stringify(items) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function deleteCached(_: IpcMainInvokeEvent, channelId: string, messageId: string) {
    try {
        const full = cachePath(channelId, messageId);
        if (existsSync(full)) unlinkSync(full);
        return { ok: true, data: full };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function purgeOlderThan(_: IpcMainInvokeEvent, cutoffMs: number) {
    try {
        const root = cacheRoot();
        let removed = 0;
        for (const channel of readdirSync(root)) {
            const dir = join(root, channel);
            let stat;
            try { stat = readdirSync(dir); } catch { continue; }
            for (const file of stat) {
                if (!file.toLowerCase().endsWith(".json")) continue;
                const full = join(dir, file);
                let loggedAt = 0;
                try {
                    const parsed = JSON.parse(readFileSync(full, "utf8"));
                    const t = Date.parse(parsed?.deletedAt || parsed?.loggedAt || "");
                    if (Number.isFinite(t)) loggedAt = t;
                } catch { /* ignore */ }
                if (loggedAt > 0 && loggedAt < cutoffMs) {
                    unlinkSync(full);
                    removed++;
                }
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
