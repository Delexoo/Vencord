/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Fetches a Wireshark/TShark bridge from the Electron main process.
 * Allowed targets: localhost and private LAN addresses only.
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import { app, IpcMainInvokeEvent } from "electron";
import { existsSync, openSync } from "fs";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { dirname, join } from "path";
import { URL } from "url";

let captureChild: ChildProcess | null = null;

function isPrivateOrLocalHost(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "127.0.0.1" || h === "localhost" || h === "::1") return true;
    if (h.startsWith("10.")) return true;
    if (h.startsWith("192.168.")) return true;
    if (h.startsWith("169.254.")) return true;
    const m = /^172\.(\d+)\./.exec(h);
    if (m) {
        const n = Number(m[1]);
        return n >= 16 && n <= 31;
    }
    return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
}

function isAllowedBridge(raw: string): boolean {
    try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        return isPrivateOrLocalHost(u.hostname);
    } catch {
        return false;
    }
}

function getText(urlStr: string, timeoutMs: number, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = u.protocol === "https:" ? httpsRequest : httpRequest;
        const headers: Record<string, string> = { Accept: "application/json" };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
            headers["X-Ipa-Token"] = token;
        }
        const req = lib(
            {
                hostname: u.hostname,
                port: u.port || (u.protocol === "https:" ? 443 : 80),
                path: `${u.pathname}${u.search}`,
                method: "GET",
                headers,
                timeout: timeoutMs
            },
            res => {
                const chunks: Buffer[] = [];
                res.on("data", c => chunks.push(Buffer.from(c)));
                res.on("end", () => {
                    const body = Buffer.concat(chunks).toString("utf8");
                    if ((res.statusCode ?? 0) >= 400) {
                        reject(new Error(`Bridge HTTP ${res.statusCode}`));
                        return;
                    }
                    resolve(body);
                });
            }
        );
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Bridge timed out"));
        });
        req.on("error", reject);
        req.end();
    });
}

function bridgePath(base: string, route: string, token: string) {
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${base}${route}${qs}`;
}

export async function fetchSnapshot(_: IpcMainInvokeEvent, rawUrl: string, token = "") {
    const base = String(rawUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
    if (!isAllowedBridge(base))
        return { ok: false, error: "Bridge URL must be localhost or a private LAN address." };

    const auth = String(token || "").trim();
    try {
        const data = await getText(bridgePath(base, "/snapshot", auth), 1200, auth);
        return { ok: true, data };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

function findPython(): { cmd: string; prefix: string[]; } {
    if (process.platform === "win32") {
        const py = spawnSync("py", ["-3", "-c", "print(3)"], {
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true
        });
        if (py.status === 0) return { cmd: "py", prefix: ["-3"] };
    }
    for (const cmd of ["python3", "python"]) {
        const probe = spawnSync(cmd, ["-c", "print(3)"], {
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true
        });
        if (probe.status === 0) return { cmd, prefix: [] };
    }
    throw new Error("Python 3 was not found. Install Python and make sure it is on PATH.");
}

function findBridgeScript(userPath: string): string {
    const custom = String(userPath || "").trim();
    if (custom && existsSync(custom)) return custom;

    const rel = join("src", "userplugins", "internetProtocolAssessment", "wireshark_bridge.py");
    const roots = [
        join(__dirname, ".."),
        join(__dirname, "../.."),
        process.cwd(),
        app.getAppPath(),
        join(app.getPath("documents"), "Vencord"),
        join(app.getPath("desktop"), "Vencord")
    ];
    for (const root of roots) {
        const full = join(root, rel);
        if (existsSync(full)) return full;
    }
    throw new Error("Could not find wireshark_bridge.py. Set Bridge script path in plugin settings.");
}

function sanitizeInterface(raw: string): string {
    const v = String(raw || "").trim();
    if (!v) return "";
    if (!/^[A-Za-z0-9_.:\\/{}\- ]{1,180}$/.test(v))
        throw new Error("Capture interface looks invalid.");
    return v;
}

function pickInterface(listText: string, preferred: string): string {
    if (preferred) return preferred;
    const lines = String(listText || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const skip = /loopback|bluetooth|wan miniport|pseudo-interface|npcap loopback/i;
    for (const line of lines) {
        if (skip.test(line)) continue;
        const m = /^(\d+)\./.exec(line);
        if (m) return m[1];
    }
    const fallback = /^(\d+)\./.exec(lines[0] || "");
    if (fallback) return fallback[1];
    throw new Error("No capture interface found. Install Wireshark/Npcap, then try Start again.");
}

function runPython(script: string, args: string[], timeoutMs: number): string {
    const py = findPython();
    const result = spawnSync(py.cmd, [...py.prefix, script, ...args], {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true
    });
    if (result.status !== 0)
        throw new Error((result.stderr || result.stdout || "Python command failed").trim());
    return String(result.stdout || "").trim();
}

async function waitForBridge(base: string, token: string): Promise<boolean> {
    for (let i = 0; i < 10; i++) {
        try {
            await getText(bridgePath(base, "/health", token), 800, token);
            return true;
        } catch {
            await new Promise(r => setTimeout(r, 400));
        }
    }
    return false;
}

function stopChild() {
    const child = captureChild;
    captureChild = null;
    if (!child || child.killed) return;
    try { child.kill(); } catch { /* ignore */ }
}

export async function startCapture(
    _: IpcMainInvokeEvent,
    rawUrl: string,
    token = "",
    interfaceName = "",
    scriptPath = "",
    geoDb = ""
) {
    const base = String(rawUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
    if (!isAllowedBridge(base))
        return { ok: false, error: "Bridge URL must be localhost or a private LAN address." };

    const auth = String(token || "").trim();
    try {
        await getText(bridgePath(base, "/health", auth), 800, auth);
        return { ok: true, data: "Capture is already running." };
    } catch { /* launch a new bridge */ }

    try {
        const script = findBridgeScript(scriptPath);
        const preferred = sanitizeInterface(interfaceName);
        const listed = runPython(script, ["--list"], 15000);
        const iface = pickInterface(listed, preferred);
        const py = findPython();
        const args = [...py.prefix, script, "--interface", iface, "--bind", "127.0.0.1"];
        const geo = String(geoDb || "").trim();
        if (geo) {
            if (!existsSync(geo)) throw new Error("GeoIP database path does not exist.");
            args.push("--geo-db", geo);
        }

        const logFile = join(app.getPath("temp"), "ipa-wireshark-bridge.log");
        const logFd = openSync(logFile, "w");
        stopChild();
        captureChild = spawn(py.cmd, args, {
            cwd: dirname(script),
            stdio: ["ignore", logFd, logFd],
            windowsHide: true
        });
        captureChild.on("exit", () => {
            if (captureChild && captureChild.exitCode != null) captureChild = null;
        });

        const up = await waitForBridge(base, auth);
        if (!up) {
            stopChild();
            return {
                ok: false,
                error: `Capture did not start. Check Wireshark/Npcap and ${logFile}`
            };
        }
        return { ok: true, data: `Capture started on interface ${iface}` };
    } catch (e) {
        stopChild();
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export async function stopCapture(_: IpcMainInvokeEvent, rawUrl: string, token = "") {
    const base = String(rawUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
    const auth = String(token || "").trim();
    if (isAllowedBridge(base)) {
        try { await getText(bridgePath(base, "/shutdown", auth), 1200, auth); } catch { /* kill child anyway */ }
    }
    stopChild();
    return { ok: true, data: "Capture stopped." };
}
