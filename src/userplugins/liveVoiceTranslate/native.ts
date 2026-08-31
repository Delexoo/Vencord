/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "child_process";
import { app, BrowserWindow, desktopCapturer, IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const CAPTIONS_PS = `
Add-Type -AssemblyName UIAutomationClient
$ErrorActionPreference = 'SilentlyContinue'
$exe = Join-Path $env:WINDIR 'System32\\LiveCaptions.exe'
function Ensure-LiveCaptions {
    $p = Get-Process -Name LiveCaptions -ErrorAction SilentlyContinue
    if (-not $p -and (Test-Path -LiteralPath $exe)) {
        Start-Process -FilePath $exe | Out-Null
        Start-Sleep -Milliseconds 900
    }
    if (Get-Process -Name LiveCaptions -ErrorAction SilentlyContinue) { 'ok' } else { 'missing' }
}
function Read-Captions {
    $procs = @(Get-Process -Name LiveCaptions -ErrorAction SilentlyContinue)
    if (-not $procs) { return '' }
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $chunks = New-Object System.Collections.Generic.List[string]
    foreach ($proc in $procs) {
        $pidCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$proc.Id)
        $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
        if (-not $win) { $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $pidCond) }
        if (-not $win) { continue }
        $textCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
        $texts = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
        foreach ($t in $texts) {
            $n = [string]$t.Current.Name
            if ($n -and $n.Length -gt 1 -and $n -notmatch '(?i)^(Live captions|Settings|Position|Caption style|Language)$') {
                $chunks.Add($n.Trim())
            }
        }
    }
    ($chunks | Select-Object -Unique) -join ' '
}
`

function historyRoot() {
    const base = join(app.getPath("documents"), "LiveVoiceTranslate");
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

async function runCaptions(extra: string, timeout = 12000) {
    const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", `${CAPTIONS_PS}\n${extra}`],
        { timeout, windowsHide: true }
    );
    return String(stdout || "").trim();
}

export async function startLiveCaptions(_: IpcMainInvokeEvent) {
    try {
        const data = await runCaptions("Ensure-LiveCaptions");
        if (data === "missing")
            return { ok: false, data: "Windows Live Captions is not installed. Use Mic, or Live Translate (API) with a key." };
        return { ok: true, data };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}

export async function readLiveCaptions(_: IpcMainInvokeEvent) {
    try {
        return { ok: true, data: await runCaptions("Read-Captions", 8000) };
    } catch (e) {
        return { ok: false, data: String(e) };
    }
}
