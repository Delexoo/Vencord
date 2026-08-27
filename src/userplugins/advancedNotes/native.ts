/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, shell, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const USERS_MAP = "_users.json";

function notesRoot() {
    const documents = app.getPath("documents");
    const next = join(documents, "AdvancedNotes");
    const legacy = join(documents, "AdvancedNote");
    if (!existsSync(next) && existsSync(legacy)) {
        try {
            renameSync(legacy, next);
        } catch {
            mkdirSync(legacy, { recursive: true });
            return legacy;
        }
    }
    mkdirSync(next, { recursive: true });
    return next;
}

function safeId(userId: string) {
    const id = String(userId ?? "").replace(/[^\d]/g, "");
    return id || "unknown";
}

/** Safe Windows filename from Discord username (unique). */
function safeUsername(username: string) {
    const name = String(username ?? "")
        .normalize("NFKC")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .trim()
        .slice(0, 80);
    return name || "unknown";
}

function notePathByUsername(username: string) {
    return join(notesRoot(), `${safeUsername(username)}.md`);
}

function notePathById(userId: string) {
    return join(notesRoot(), `${safeId(userId)}.md`);
}

function readUsersMap(): Record<string, string> {
    try {
        const full = join(notesRoot(), USERS_MAP);
        if (!existsSync(full)) return {};
        const parsed = JSON.parse(readFileSync(full, "utf8"));
        return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
    } catch {
        return {};
    }
}

function writeUsersMap(map: Record<string, string>) {
    writeFileSync(join(notesRoot(), USERS_MAP), JSON.stringify(map, null, 2), "utf8");
}

function frontmatterUserId(filePath: string): string | null {
    try {
        const text = readFileSync(filePath, "utf8");
        const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!m) return null;
        const id = m[1].match(/userId:\s*"(\d+)"/);
        return id?.[1] ?? null;
    } catch {
        return null;
    }
}

/** Locate an existing note for this Discord user (by map, id file, or frontmatter). */
function findExistingNote(userId: string, username?: string): string | null {
    const id = safeId(userId);
    const root = notesRoot();
    const map = readUsersMap();
    const candidates: string[] = [];

    if (username) candidates.push(notePathByUsername(username));
    candidates.push(notePathById(id));

    const mapped = map[id];
    if (mapped) candidates.push(notePathByUsername(mapped));

    for (const p of candidates) {
        if (existsSync(p)) return p;
    }

    // Scan notes for matching userId in frontmatter (covers renames before map existed)
    try {
        for (const f of readdirSync(root)) {
            if (!f.toLowerCase().endsWith(".md")) continue;
            const full = join(root, f);
            if (frontmatterUserId(full) === id) return full;
        }
    } catch { /* ignore */ }

    return null;
}

/**
 * Ensure the note lives at `{username}.md`.
 * Renames when Discord username changes, and migrates legacy `{userId}.md`.
 */
function resolveNotePath(username: string, userId: string): string {
    const id = safeId(userId);
    const name = String(username ?? "").trim() || id;
    const target = notePathByUsername(name);
    const existing = findExistingNote(id, name);

    if (existing && existing !== target) {
        try {
            if (existsSync(target)) {
                // Prefer the existing content if target is empty/new; otherwise keep target
                const existingText = readFileSync(existing, "utf8");
                const targetText = readFileSync(target, "utf8");
                if (!targetText.trim() && existingText.trim()) {
                    writeFileSync(target, existingText, "utf8");
                }
                unlinkSync(existing);
            } else {
                renameSync(existing, target);
            }
        } catch { /* still use target */ }
    }

    const map = readUsersMap();
    const key = safeUsername(name);
    if (map[id] !== key) {
        map[id] = key;
        try { writeUsersMap(map); } catch { /* ignore */ }
    }

    return target;
}

export async function getNotesDir(_: IpcMainInvokeEvent) {
    try {
        return { ok: true, data: notesRoot() };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function listNoteFiles(_: IpcMainInvokeEvent) {
    try {
        const files = readdirSync(notesRoot())
            .filter(f => f.toLowerCase().endsWith(".md"))
            .sort((a, b) => a.localeCompare(b));
        return { ok: true, data: JSON.stringify(files) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function readNote(_: IpcMainInvokeEvent, userId: string, username?: string) {
    try {
        const name = String(username ?? "").trim() || safeId(userId);
        const full = resolveNotePath(name, userId);
        if (!existsSync(full)) return { ok: true, data: "" };
        return { ok: true, data: readFileSync(full, "utf8") };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function writeNote(_: IpcMainInvokeEvent, userId: string, content: string, username?: string) {
    try {
        const name = String(username ?? "").trim() || safeId(userId);
        const full = resolveNotePath(name, userId);
        writeFileSync(full, content ?? "", "utf8");
        return { ok: true, data: full };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function deleteNote(_: IpcMainInvokeEvent, userId: string, username?: string) {
    try {
        const id = safeId(userId);
        const name = String(username ?? "").trim();
        const targets = new Set<string>();
        if (name) targets.add(notePathByUsername(name));
        targets.add(notePathById(id));

        const existing = findExistingNote(id, name || undefined);
        if (existing) targets.add(existing);

        for (const full of targets) {
            if (existsSync(full)) unlinkSync(full);
        }

        const map = readUsersMap();
        if (map[id]) {
            delete map[id];
            try { writeUsersMap(map); } catch { /* ignore */ }
        }

        return { ok: true, data: name ? notePathByUsername(name) : notePathById(id) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function openNotesFolder(_: IpcMainInvokeEvent) {
    try {
        const dir = notesRoot();
        await shell.openPath(dir);
        return { ok: true, data: dir };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}
