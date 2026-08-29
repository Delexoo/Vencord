/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { request as httpsRequest } from "https";

const OWNER = "Delexoo";
const REPO = "Vencord";
const FILE_PATH = "src/userplugins/_delexo/shareRegistry.json";
const BRANCH = "main";
const API_HOST = "api.github.com";

type ShareKind = "badges" | "buttons";

function parseKind(kind: string): ShareKind | null {
    switch (kind) {
        case "badges":
        case "buttons":
            return kind;
        default:
            return null;
    }
}

function githubToken() {
    const env = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim();
    if (env) return env;
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
                if (!line.toUpperCase().startsWith("GITHUB_TOKEN")) continue;
                const eq = line.indexOf("=");
                if (eq < 0) continue;
                const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
                if (value) return value;
            }
        } catch {
            /* ignore unreadable env files */
        }
    }
    return "";
}

function api(method: string, apiPath: string, token: string, body?: string): Promise<{ status: number; text: string; }> {
    return new Promise((resolve, reject) => {
        const req = httpsRequest({
            hostname: API_HOST,
            path: apiPath,
            method,
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "DelexoShare",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
                ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
            },
        }, res => {
            const chunks: Buffer[] = [];
            res.on("data", chunk => chunks.push(Buffer.from(chunk)));
            res.on("end", () => resolve({
                status: res.statusCode ?? 0,
                text: Buffer.concat(chunks).toString("utf8"),
            }));
        });
        req.on("error", reject);
        req.setTimeout(20000, () => req.destroy(new Error("GitHub request timed out")));
        if (body) req.write(body);
        req.end();
    });
}

function emptyRegistry() {
    return { badges: {} as Record<string, string>, buttons: {} as Record<string, unknown> };
}

function parseRegistry(raw: string) {
    const next = emptyRegistry();
    try {
        const parsed = JSON.parse(raw) as { badges?: unknown; buttons?: unknown; };
        if (parsed?.badges && typeof parsed.badges === "object") {
            for (const [id, hex] of Object.entries(parsed.badges as Record<string, unknown>)) {
                if (/^\d{16,22}$/.test(id) && typeof hex === "string" && /^[0-9a-f]+$/i.test(hex))
                    next.badges[id] = hex.toLowerCase();
            }
        }
        if (parsed?.buttons && typeof parsed.buttons === "object") {
            next.buttons = parsed.buttons as Record<string, unknown>;
        }
    } catch {
        /* keep empty */
    }
    return next;
}

async function readFile(token: string) {
    const res = await api("GET", `/repos/${OWNER}/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, token);
    if (res.status === 404) return { sha: "", json: emptyRegistry() };
    if (res.status === 401 || res.status === 403) throw new Error("GitHub auth failed");
    if (res.status < 200 || res.status >= 300) throw new Error(`GitHub read failed (${res.status})`);
    const parsed = JSON.parse(res.text) as { sha?: string; content?: string; encoding?: string; };
    const b64 = String(parsed.content ?? "").replace(/\n/g, "");
    const text = Buffer.from(b64, parsed.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    return { sha: String(parsed.sha ?? ""), json: parseRegistry(text) };
}

async function writeFile(token: string, json: ReturnType<typeof emptyRegistry>, sha: string) {
    const content = Buffer.from(`${JSON.stringify(json, null, 4)}\n`, "utf8").toString("base64");
    const body = JSON.stringify({
        message: "Update Delexo share registry.",
        content,
        sha: sha || undefined,
        branch: BRANCH,
        committer: { name: "Delexoo", email: "teambrilliantt@hotmail.com" },
        author: { name: "Delexoo", email: "teambrilliantt@hotmail.com" },
    });
    const res = await api("PUT", `/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`, token, body);
    if (res.status === 409) return { conflict: true as const };
    if (res.status === 401 || res.status === 403) throw new Error("GitHub auth failed");
    if (res.status < 200 || res.status >= 300) throw new Error(`GitHub write failed (${res.status})`);
    return { conflict: false as const };
}

export async function fetchShareRegistry(_: IpcMainInvokeEvent) {
    try {
        const token = githubToken();
        if (!token) return { ok: false, data: "missing-token" };
        const file = await readFile(token);
        return { ok: true, data: JSON.stringify(file.json) };
    } catch (e) {
        return { ok: false, data: e instanceof Error ? e.message : String(e) };
    }
}

export async function publishShare(_: IpcMainInvokeEvent, kind: string, userId: string, payload: string) {
    try {
        const id = String(userId ?? "").trim();
        if (!/^\d{16,22}$/.test(id)) return { ok: false, data: "bad-user" };
        const shareKind = parseKind(kind);
        if (!shareKind) return { ok: false, data: "bad-kind" };
        const token = githubToken();
        if (!token) return { ok: false, data: "missing-token" };

        for (let attempt = 0; attempt < 3; attempt++) {
            const file = await readFile(token);
            switch (shareKind) {
                case "badges": {
                    const hex = String(payload ?? "").trim().toLowerCase();
                    if (!hex || hex === "0") delete file.json.badges[id];
                    else if (/^[0-9a-f]+$/.test(hex)) file.json.badges[id] = hex;
                    else return { ok: false, data: "bad-payload" };
                    break;
                }
                case "buttons": {
                    const raw = String(payload ?? "").trim();
                    if (!raw) {
                        delete file.json.buttons[id];
                        break;
                    }
                    try {
                        file.json.buttons[id] = JSON.parse(raw);
                    } catch {
                        return { ok: false, data: "bad-payload" };
                    }
                    break;
                }
                default: {
                    const _: never = shareKind;
                    return _;
                }
            }
            const saved = await writeFile(token, file.json, file.sha);
            if (!saved.conflict) return { ok: true, data: JSON.stringify(file.json) };
        }
        return { ok: false, data: "conflict" };
    } catch (e) {
        return { ok: false, data: e instanceof Error ? e.message : String(e) };
    }
}
