/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Delexo } from "../_delexo/author";
import { scheduleOnce } from "../_delexo/idle";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { getIntlMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { createRoot, SelectedChannelStore, Toasts, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

import {
    concatPcm,
    encodePcmRecording,
    encodeWav,
    FORMAT_OPTIONS,
    isPcmFormat,
    isRecordFormat,
    normalizeFormat,
    recorderMimeFor,
    type RecordFormat
} from "./encode";
import managedStyle from "./style.css?managed";

const Native = VencordNative.pluginHelpers.AudioCapture as PluginNative<typeof import("./native")> | undefined;
const log = new Logger("AudioCapture");

const HOST_ID = "vc-audio-capture-voice-host";
const PANEL_ID = "vc-audio-capture-panel";

const settings = definePluginSettings({
    autoVoice: {
        type: OptionType.BOOLEAN,
        description: "Start recording automatically when you join a voice chat",
        default: true
    },
    captureSource: {
        type: OptionType.SELECT,
        description: "What to record in voice chats",
        options: [
            { label: "Mic + Discord / system audio (recommended)", value: "mic_discord", default: true },
            { label: "Discord / system audio only", value: "discord" },
            { label: "Microphone only", value: "mic" }
        ]
    },
    recordDir: {
        type: OptionType.STRING,
        description: "Folder where recordings are saved (blank = Videos/AudioCapture)",
        default: ""
    },
    recordFormat: {
        type: OptionType.SELECT,
        description: "Recording format",
        options: FORMAT_OPTIONS
    },
    lastFilePath: {
        type: OptionType.STRING,
        description: "Last saved recording path (auto)",
        default: "",
        hidden: true
    }
});

type CaptureMode = "mic" | "discord" | "mic_discord";

function captureMode(): CaptureMode {
    const src = settings.store.captureSource || "mic_discord";
    if (src === "mic" || src === "discord" || src === "mic_discord") return src;
    return "mic_discord";
}

let hostRoot: Root | null = null;
let panelRoot: Root | null = null;
let observer: MutationObserver | null = null;
const placeHostSoon = scheduleOnce(150);
let capturing = false;
let inVoice = false;
let lastFile = "";
let panelOpen = false;
let wantedCapture = false;
let startToken = 0;
let recordStartedAt: number | null = null;
let resolvedRecordDir = "";

let mediaRecorder: MediaRecorder | null = null;
let recorderMime = "audio/webm";
let activeStreams: MediaStream[] = [];
let audioCtx: AudioContext | null = null;
let recordedChunks: BlobPart[] = [];
let pcmChunks: Float32Array[] = [];
let pcmSampleRate = 48000;
let activeFormat: RecordFormat = "wav";
let processorNode: ScriptProcessorNode | null = null;

function inVoiceNow() {
    return Boolean(SelectedChannelStore.getVoiceChannelId?.());
}

function markRecordingStarted() {
    if (recordStartedAt == null) recordStartedAt = Date.now();
}

function clearRecordingTimer() {
    recordStartedAt = null;
}

function formatElapsed(ms: number) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function recordingElapsedLabel() {
    if (recordStartedAt == null) return null;
    return formatElapsed(Date.now() - recordStartedAt);
}

function displayDuration() {
    return recordingElapsedLabel() ?? "00:00";
}

async function resolveRecordDir() {
    if (settings.store.recordDir?.trim()) {
        resolvedRecordDir = settings.store.recordDir.trim();
    } else if (Native) {
        const res = await Native.getDefaultRecordDir();
        resolvedRecordDir = res.ok ? res.data : "";
    }
    if (!resolvedRecordDir) resolvedRecordDir = "AudioCapture";
    if (Native) await Native.ensureDir(resolvedRecordDir);
    return resolvedRecordDir;
}

function stopTracks() {
    for (const s of activeStreams) {
        for (const t of s.getTracks()) {
            try { t.stop(); } catch { /* ignore */ }
        }
    }
    activeStreams = [];
    try { processorNode?.disconnect(); } catch { /* ignore */ }
    processorNode = null;
    try { void audioCtx?.close(); } catch { /* ignore */ }
    audioCtx = null;
}

async function getMicStream() {
    return await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        },
        video: false
    });
}

async function getSystemAudioStream() {
    if (!Native) throw new Error("Native helper unavailable");
    const res = await Native.listDesktopAudioSources();
    if (!res.ok) throw new Error(res.data);
    const sources = JSON.parse(res.data) as {
        id: string;
        name: string;
        isDiscord?: boolean;
        isScreen?: boolean;
    }[];
    if (!sources.length) throw new Error("No desktop audio sources found");

    // On Windows, loopback audio usually comes from a screen source - not a single window.
    // Try screens first, then Discord window, then anything else.
    const ordered = [
        ...sources.filter(s => s.isScreen),
        ...sources.filter(s => s.isDiscord && !s.isScreen),
        ...sources.filter(s => !s.isScreen && !s.isDiscord),
    ];

    let lastError: unknown;
    for (const preferred of ordered) {
        try {
            const stream = await (navigator.mediaDevices as any).getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: "desktop",
                        chromeMediaSourceId: preferred.id
                    }
                },
                video: {
                    mandatory: {
                        chromeMediaSource: "desktop",
                        chromeMediaSourceId: preferred.id,
                        maxWidth: 2,
                        maxHeight: 2
                    }
                }
            });
            for (const t of stream.getVideoTracks()) {
                t.stop();
                stream.removeTrack(t);
            }
            if (stream.getAudioTracks().length)
                return stream as MediaStream;
            for (const t of stream.getTracks()) t.stop();
            lastError = new Error(`No audio on source: ${preferred.name}`);
        } catch (e) {
            lastError = e;
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error("System/Discord audio not available on this device");
}

async function blobToBase64(blob: Blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function uint8ToBase64(bytes: Uint8Array) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk)
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
}

async function startCapture() {
    if (!Native) {
        Toasts.show({
            message: "AudioCapture needs the Discord desktop app.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }
    if (!inVoiceNow()) {
        wantedCapture = false;
        capturing = false;
        rerenderAll();
        return;
    }

    const token = ++startToken;
    wantedCapture = true;
    capturing = true;
    rerenderAll();

    try {
        await resolveRecordDir();
        if (!wantedCapture || token !== startToken || !inVoiceNow()) return;

        stopTracks();
        recordedChunks = [];
        pcmChunks = [];
        activeFormat = normalizeFormat(settings.store.recordFormat);

        const mode = captureMode();
        const streams: MediaStream[] = [];
        if (mode === "mic" || mode === "mic_discord") {
            streams.push(await getMicStream());
        }
        if (mode === "discord" || mode === "mic_discord") {
            try {
                streams.push(await getSystemAudioStream());
            } catch (e) {
                log.warn("System/Discord audio unavailable", e);
                if (mode === "discord") throw e;
                Toasts.show({
                    message: "Couldn't capture Discord audio - recording mic only.",
                    id: Toasts.genId(),
                    type: Toasts.Type.MESSAGE
                });
            }
        }
        if (!streams.length) throw new Error("No audio streams");
        activeStreams = streams;

        audioCtx = new AudioContext();

        if (isPcmFormat(activeFormat)) {
            // MediaStreamDestination has 0 Web Audio outputs - mix via GainNode instead.
            const mixer = audioCtx.createGain();
            for (const s of streams) {
                audioCtx.createMediaStreamSource(s).connect(mixer);
            }
            pcmSampleRate = audioCtx.sampleRate;
            processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
            const silence = audioCtx.createGain();
            silence.gain.value = 0;
            processorNode.onaudioprocess = ev => {
                if (!wantedCapture) return;
                pcmChunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
            };
            mixer.connect(processorNode);
            processorNode.connect(silence);
            silence.connect(audioCtx.destination);
            markRecordingStarted();
            capturing = true;
            rerenderAll();
            return;
        }

        const dest = audioCtx.createMediaStreamDestination();
        for (const s of streams) {
            audioCtx.createMediaStreamSource(s).connect(dest);
        }

        const recorderFormat = activeFormat === "m4a" ? "m4a" : "webm";
        const mime = recorderMimeFor(recorderFormat);
        if (!mime) throw new Error(`This Discord build can't record ${recorderFormat.toUpperCase()}`);
        recorderMime = mime;
        mediaRecorder = new MediaRecorder(dest.stream, { mimeType: mime });
        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };
        mediaRecorder.start(1000);
        markRecordingStarted();
        capturing = true;
        rerenderAll();
    } catch (e) {
        log.error("startCapture failed", e);
        wantedCapture = false;
        capturing = false;
        clearRecordingTimer();
        stopTracks();
        Toasts.show({
            message: `Recording failed: ${e instanceof Error ? e.message : String(e)}`,
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        rerenderAll();
    }
}

async function stopCapture() {
    wantedCapture = false;
    startToken += 1;
    capturing = false;
    clearRecordingTimer();
    rerenderAll();

    const dir = resolvedRecordDir || (await resolveRecordDir());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const format = activeFormat;

    try {
        if (isPcmFormat(format)) {
            let ext = format;
            let bytes: Uint8Array;
            try {
                const encoded = await encodePcmRecording(format, pcmChunks, pcmSampleRate);
                bytes = encoded.bytes;
                ext = encoded.ext;
            } catch (e) {
                log.error("encode failed, saving WAV", e);
                bytes = encodeWav(concatPcm(pcmChunks), pcmSampleRate);
                ext = "wav";
                Toasts.show({
                    message: `Couldn't encode ${format.toUpperCase()} — saved WAV instead.`,
                    id: Toasts.genId(),
                    type: Toasts.Type.MESSAGE
                });
            }
            pcmChunks = [];
            if (bytes.length && Native) {
                const b64 = uint8ToBase64(bytes);
                const res = await Native.writeRecording(dir, `discord-capture-${stamp}.${ext}`, b64);
                if (res.ok) {
                    lastFile = res.data;
                    settings.store.lastFilePath = res.data;
                }
            }
        } else if (mediaRecorder) {
            const rec = mediaRecorder;
            mediaRecorder = null;
            await new Promise<void>(resolve => {
                rec.onstop = () => resolve();
                try { rec.stop(); } catch { resolve(); }
            });
            const ext = format === "m4a" ? "m4a" : "webm";
            const blob = new Blob(recordedChunks, { type: recorderMime });
            recordedChunks = [];
            if (blob.size > 0 && Native) {
                const b64 = await blobToBase64(blob);
                const res = await Native.writeRecording(dir, `discord-capture-${stamp}.${ext}`, b64);
                if (res.ok) {
                    lastFile = res.data;
                    settings.store.lastFilePath = res.data;
                }
            }
        }
    } catch (e) {
        log.error("stopCapture save failed", e);
    } finally {
        stopTracks();
        rerenderAll();
    }
}

function syncVoice(channelId: string | null) {
    const now = Boolean(channelId);
    inVoice = now;
    if (!now) {
        panelOpen = false;
        void stopCapture();
        teardownPanel();
        teardownHost();
        rerenderAll();
        return;
    }
    if (settings.store.autoVoice) void startCapture();
    queuePlaceHost();
    rerenderAll();
}

function RecordIcon({ on }: { on: boolean; }) {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            {on
                ? <circle className="vc-ac-rec-dot" cx="12" cy="12" r="6.5" fill="currentColor" />
                : <circle cx="12" cy="12" r="5.5" fill="currentColor" />}
        </svg>
    );
}

type SelectOption = { value: string; label: string; };

function NiceSelect({
    label,
    value,
    options,
    onChange
}: {
    label: string;
    value: string;
    options: SelectOption[];
    onChange: (value: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const selected = options.find(o => o.value === value) ?? options[0];

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            const t = e.target as Node | null;
            if (t && rootRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDoc, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDoc, true);
            document.removeEventListener("keydown", onKey, true);
        };
    }, [open]);

    return (
        <div className="vc-ac-field">
            <span id={`vc-ac-dd-${label.replace(/\s+/g, "-").toLowerCase()}`}>{label}</span>
            <div
                ref={rootRef}
                className={"vc-ac-dd" + (open ? " is-open" : "")}
            >
                <button
                    type="button"
                    className="vc-ac-dd-btn"
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-labelledby={`vc-ac-dd-${label.replace(/\s+/g, "-").toLowerCase()}`}
                    onClick={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setOpen(v => !v);
                    }}
                >
                    <span className="vc-ac-dd-value">{selected?.label ?? value}</span>
                    <span className="vc-ac-dd-caret" aria-hidden="true" />
                </button>
                {open && (
                    <div className="vc-ac-dd-menu" role="listbox">
                        {options.map(opt => (
                            <button
                                key={opt.value}
                                type="button"
                                role="option"
                                aria-selected={opt.value === value}
                                className={"vc-ac-dd-item" + (opt.value === value ? " is-on" : "")}
                                onClick={e => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onChange(opt.value);
                                    setOpen(false);
                                }}
                            >
                                <span className="vc-ac-dd-item-label">{opt.label}</span>
                                {opt.value === value ? (
                                    <span className="vc-ac-dd-check" aria-hidden="true">✓</span>
                                ) : null}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function CapturePanel({ anchor }: { anchor: DOMRect | null; }) {
    const [on, setOn] = useState(capturing);
    const [voice, setVoice] = useState(inVoice);
    const [fmt, setFmt] = useState(settings.store.recordFormat || "wav");
    const [folder, setFolder] = useState(settings.store.recordDir || resolvedRecordDir || "Videos/AudioCapture");
    const [file, setFile] = useState(lastFile);
    const [advanced, setAdvanced] = useState(false);
    const [autoVoice, setAutoVoice] = useState(settings.store.autoVoice);
    const [src, setSrc] = useState(captureMode());
    const [elapsed, setElapsed] = useState(displayDuration());
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const tick = window.setInterval(() => {
            setOn(capturing);
            setVoice(inVoice);
            setFile(lastFile);
            setFmt(settings.store.recordFormat || "wav");
            setFolder(settings.store.recordDir || resolvedRecordDir || "Videos/AudioCapture");
            setAutoVoice(settings.store.autoVoice);
            setSrc(captureMode());
            setElapsed(displayDuration());
        }, 500);
        return () => window.clearInterval(tick);
    }, []);

    useLayoutEffect(() => {
        if (!panelRef.current || !anchor) return;
        const el = panelRef.current;
        const width = el.offsetWidth || 260;
        const left = Math.min(
            Math.max(8, Math.round(anchor.left + anchor.width / 2 - width / 2)),
            window.innerWidth - width - 8
        );
        const bottom = Math.round(window.innerHeight - anchor.top + 10);
        el.style.left = `${left}px`;
        el.style.bottom = `${bottom}px`;
    }, [anchor, advanced]);

    const shortFolder = folder.length > 34 ? `...${folder.slice(-32)}` : folder;

    return (
        <div ref={panelRef} id={PANEL_ID} className="vc-ac-panel" role="dialog" aria-label="Audio Capture">
            <div className="vc-ac-panel-head">
                <span className="vc-ac-panel-title">Audio Capture</span>
                <span className={"vc-ac-dot" + (on ? " on" : "")} aria-label={on ? "Recording" : "Idle"} />
            </div>

            <button
                type="button"
                className={"vc-ac-main-btn" + (on ? " is-on" : "")}
                disabled={!voice && !on}
                aria-live="polite"
                onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (on) void stopCapture();
                    else void startCapture();
                }}
            >
                {on ? `Stop - ${elapsed}` : voice ? "Start recording" : "Join voice to record"}
            </button>

            <button
                type="button"
                className="vc-ac-advanced-toggle"
                onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    setAdvanced(v => !v);
                }}
            >
                {advanced ? "Hide advanced" : "Advanced options"}
            </button>

            {advanced && (
                <div className="vc-ac-advanced">
                    <NiceSelect
                        label="Capture source"
                        value={src}
                        options={[
                            { value: "mic_discord", label: "Mic + Discord" },
                            { value: "discord", label: "Discord / system" },
                            { value: "mic", label: "Mic only" },
                        ]}
                        onChange={nextRaw => {
                            const next = nextRaw === "mic" || nextRaw === "discord"
                                ? nextRaw
                                : "mic_discord";
                            settings.store.captureSource = next;
                            setSrc(next);
                            if (capturing && inVoice) void startCapture();
                        }}
                    />

                    <NiceSelect
                        label="File type"
                        value={fmt}
                        options={FORMAT_OPTIONS.map(opt => ({ value: opt.value, label: opt.label }))}
                        onChange={nextRaw => {
                            if (!isRecordFormat(nextRaw)) return;
                            settings.store.recordFormat = nextRaw;
                            setFmt(nextRaw);
                        }}
                    />

                    <div className="vc-ac-field">
                        <span>Save to</span>
                        <div className="vc-ac-path-row">
                            <span className="vc-ac-path" title={folder}>{shortFolder}</span>
                            <button
                                type="button"
                                className="vc-ac-browse"
                                onClick={async e => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (!Native?.pickFolder) return;
                                    const res = await Native.pickFolder();
                                    if (res.ok && res.data) {
                                        settings.store.recordDir = res.data;
                                        setFolder(res.data);
                                        resolvedRecordDir = res.data;
                                    }
                                }}
                            >
                                Browse
                            </button>
                        </div>
                    </div>

                    <label className="vc-ac-check">
                        <input
                            type="checkbox"
                            checked={autoVoice}
                            onChange={e => {
                                settings.store.autoVoice = e.target.checked;
                                setAutoVoice(e.target.checked);
                            }}
                        />
                        Auto-start when joining voice
                    </label>
                    <div className="vc-ac-hint">
                        Capture always stops when you leave a voice chat.
                    </div>
                    {file ? (
                        <div className="vc-ac-hint" title={file}>
                            Last file: {file.split(/[/\\]/).pop()}
                        </div>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function VoiceCaptureButton() {
    const [on, setOn] = useState(capturing);
    const [open, setOpen] = useState(panelOpen);
    const [showTip, setShowTip] = useState(false);
    const btnRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const tick = window.setInterval(() => {
            setOn(capturing);
            setOpen(panelOpen);
        }, 500);
        return () => window.clearInterval(tick);
    }, []);

    return (
        <button
            ref={btnRef}
            type="button"
            className={"vc-ac-native-btn" + (on ? " vc-ac-on" : "")}
            aria-label="Audio capture"
            aria-expanded={open}
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
            onFocus={() => setShowTip(true)}
            onBlur={() => setShowTip(false)}
            onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                setShowTip(false);
                panelOpen = !panelOpen;
                setOpen(panelOpen);
                placePanel(btnRef.current?.getBoundingClientRect() ?? null);
            }}
        >
            <div className="vc-ac-icon-wrap">
                <RecordIcon on={on} />
            </div>
            {showTip && (
                <span className="vc-ac-tip" role="tooltip">
                    Audio capture
                </span>
            )}
        </button>
    );
}

function rerenderAll() {
    hostRoot?.render(<VoiceCaptureButton />);
    if (panelOpen)
        placePanel(document.getElementById(HOST_ID)?.getBoundingClientRect() ?? null);
    else
        teardownPanel();
}

function placePanel(anchor: DOMRect | null) {
    if (!panelOpen) {
        teardownPanel();
        return;
    }
    let mount = document.getElementById(PANEL_ID + "-root");
    if (!mount) {
        mount = document.createElement("div");
        mount.id = PANEL_ID + "-root";
        document.body.appendChild(mount);
        panelRoot = createRoot(mount);
    }
    panelRoot?.render(<CapturePanel anchor={anchor} />);
}

function teardownPanel() {
    panelRoot?.unmount();
    panelRoot = null;
    document.getElementById(PANEL_ID + "-root")?.remove();
}

function buttonLabel(btn: Element) {
    return (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").trim().toLowerCase();
}

function findSoundboardButton() {
    const labels = [
        getIntlMessage("SOUNDBOARD_OPEN"),
        getIntlMessage("SOUNDBOARD"),
        "Open Soundboard",
        "Soundboard"
    ].filter(Boolean).map(s => String(s).trim().toLowerCase());

    const scoped = document.querySelectorAll<HTMLElement>(
        '[class*="buttons"] button, [class*="actionBar"] button, [class*="actionButtons"] button, [aria-label*="oundboard" i]'
    );
    for (const btn of scoped) {
        const label = buttonLabel(btn);
        if (!label) continue;
        if (labels.some(l => label === l || label.includes(l))) return btn;
        if (label.includes("soundboard")) return btn;
    }
    return null;
}

function findActionBar(soundboardBtn: HTMLElement) {
    let el: HTMLElement | null = soundboardBtn.parentElement;
    for (let i = 0; el && i < 6; i++) {
        const kids = Array.from(el.children).filter((c): c is HTMLElement =>
            c instanceof HTMLElement
                ? c.id === HOST_ID
                    ? true
                    : c === soundboardBtn || c.tagName === "BUTTON" || !!c.querySelector("button")
                : false
        );
        if (kids.length >= 2) {
            const anchor = kids.find(c => c === soundboardBtn || c.contains(soundboardBtn)) ?? soundboardBtn;
            return { bar: el, anchor };
        }
        el = el.parentElement;
    }
    return soundboardBtn.parentElement
        ? { bar: soundboardBtn.parentElement, anchor: soundboardBtn }
        : null;
}

function copyBox(from: HTMLElement, to: HTMLElement) {
    const cs = window.getComputedStyle(from);
    const sizePx = `${from.offsetHeight || Math.round(parseFloat(cs.height)) || 32}px`;
    to.style.boxSizing = "border-box";
    to.style.display = "flex";
    to.style.alignItems = "center";
    to.style.justifyContent = "center";
    to.style.flex = "0 0 auto";
    to.style.flexGrow = "0";
    to.style.flexShrink = "0";
    to.style.width = sizePx;
    to.style.height = sizePx;
    to.style.minWidth = sizePx;
    to.style.minHeight = sizePx;
    to.style.maxWidth = sizePx;
    to.style.maxHeight = sizePx;
    to.style.margin = cs.margin;
    to.style.padding = "0";
    to.style.borderRadius = "50%";
    to.style.overflow = "visible";
    to.style.position = cs.position === "static" ? "relative" : cs.position;
    to.style.verticalAlign = cs.verticalAlign;
}

function mountHost(host: HTMLElement) {
    hostRoot?.unmount();
    hostRoot = createRoot(host);
    hostRoot.render(
        <ErrorBoundary noop>
            <VoiceCaptureButton />
        </ErrorBoundary>
    );
}

function placeHost() {
    try {
        if (!inVoiceNow()) {
            teardownHost();
            teardownPanel();
            return;
        }
        const existing = document.getElementById(HOST_ID);
        if (existing?.isConnected && existing.previousElementSibling && hostRoot) return;

        const sb = findSoundboardButton();
        if (!sb) {
            teardownHost();
            return;
        }
        const found = findActionBar(sb);
        if (!found) {
            teardownHost();
            return;
        }
        const { bar, anchor } = found;
        let host = document.getElementById(HOST_ID);
        if (host && host.parentElement === bar && anchor.nextElementSibling === host) {
            copyBox(anchor, host);
            if (!hostRoot) mountHost(host);
            return;
        }
        host?.remove();
        hostRoot?.unmount();
        hostRoot = null;

        host = document.createElement("div");
        host.id = HOST_ID;
        host.className = "vc-audio-capture-sb-host";
        copyBox(anchor, host);
        if (anchor.nextSibling) bar.insertBefore(host, anchor.nextSibling);
        else bar.appendChild(host);
        mountHost(host);
    } catch (err) {
        log.error("Failed to place audio capture button", err);
    }
}

function teardownHost() {
    hostRoot?.unmount();
    hostRoot = null;
    document.getElementById(HOST_ID)?.remove();
}

function queuePlaceHost() {
    placeHostSoon.run(placeHost);
}

function onDocClick(e: MouseEvent) {
    if (!panelOpen) return;
    const t = e.target as Node;
    const panel = document.getElementById(PANEL_ID);
    const host = document.getElementById(HOST_ID);
    if (panel?.contains(t) || host?.contains(t)) return;
    panelOpen = false;
    teardownPanel();
}

export default definePlugin({
    name: "AudioCapture",
    description: "Record mic and/or Discord voice audio next to Open Soundboard. Standalone, no external engine.",
    tags: ["Voice", "Utility"],
    searchTerms: ["record", "capture", "audio", "voice", "soundboard", "wav", "mp3", "ogg", "flac"],
    authors: [Delexo],
    settings,
    managedStyle,

    flux: {
        VOICE_CHANNEL_SELECT({ channelId }: { channelId?: string | null; }) {
            syncVoice(channelId ?? null);
        },
        RTC_CONNECTION_STATE() {
            syncVoice(SelectedChannelStore.getVoiceChannelId?.() ?? null);
        },
        VOICE_CHANNEL_SELECT_V2({ channelId }: { channelId?: string | null; }) {
            syncVoice(channelId ?? SelectedChannelStore.getVoiceChannelId?.() ?? null);
        },
        CHANNEL_SELECT() {
            syncVoice(SelectedChannelStore.getVoiceChannelId?.() ?? null);
        }
    },

    start() {
        inVoice = inVoiceNow();
        lastFile = settings.store.lastFilePath || "";
        void resolveRecordDir();
        observer = new MutationObserver(() => {
            if (!inVoiceNow()) {
                if (document.getElementById(HOST_ID)) queuePlaceHost();
                return;
            }
            if (document.getElementById(HOST_ID)?.isConnected) return;
            queuePlaceHost();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("click", onDocClick, true);
        placeHost();
        if (inVoice && settings.store.autoVoice)
            void startCapture();
        else if (!inVoice)
            void stopCapture();
    },

    stop() {
        placeHostSoon.cancel();
        observer?.disconnect();
        observer = null;
        document.removeEventListener("click", onDocClick, true);
        panelOpen = false;
        teardownPanel();
        teardownHost();
        void stopCapture();
    }
});
