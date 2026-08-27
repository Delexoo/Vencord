/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Floating overlay for YOUR OWN Discord voice connection metrics only.
 * No packet capture, Wireshark, geo, or other participants' network data.
 */

import { Delexo } from "../_delexo/author";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelStore,
    createRoot,
    MediaEngineStore,
    RTCConnectionStore,
    SelectedChannelStore,
    UserStore,
    VoiceStateStore
} from "@webpack/common";
import type { Root } from "react-dom/client";

import managedStyle from "./style.css?managed";

const ROOT_ID = "vc-ipa-root";
const UI_STORE_KEY = "IpaUiState";
const HISTORY_LEN = 48;

const settings = definePluginSettings({
    showOverlay: {
        type: OptionType.BOOLEAN,
        description: "Show the floating connection overlay",
        default: true,
        onChange(v: boolean) {
            if (v) void ensureUi();
            else teardownUi();
        }
    }
});

type UiState = {
    minimized: boolean;
    maximized: boolean;
    pos: { left: number; top: number; };
};

let uiState: UiState = {
    minimized: false,
    maximized: false,
    pos: { left: 0, top: 0 }
};

let mount: HTMLDivElement | null = null;
let root: Root | null = null;
let dragging = false;
let dragOffset = { x: 0, y: 0 };
let pollHandle: ReturnType<typeof setInterval> | null = null;
let resizeBound = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

interface SelfStats {
    channelName: string;
    peerCount: number;
    mode: string;
    quality: string;
    rttMs: number | null;
    packetLossPct: number | null;
    jitterMs: number | null;
    bitrateKbps: number | null;
    hostname: string;
    connected: boolean;
    reconnecting: boolean;
    speaking: boolean;
    video: boolean;
    streaming: boolean;
    muted: boolean;
    deafened: boolean;
    state: string;
    packetsIn: number | null;
    packetsOut: number | null;
    packetsLost: number | null;
    pingHistory: number[];
    lossHistory: number[];
}

const EMPTY_STATS: SelfStats = {
    channelName: "-",
    peerCount: 0,
    mode: "-",
    quality: "-",
    rttMs: null,
    packetLossPct: null,
    jitterMs: null,
    bitrateKbps: null,
    hostname: "-",
    connected: false,
    reconnecting: false,
    speaking: false,
    video: false,
    streaming: false,
    muted: false,
    deafened: false,
    state: "-",
    packetsIn: null,
    packetsOut: null,
    packetsLost: null,
    pingHistory: [],
    lossHistory: []
};

let stats: SelfStats = EMPTY_STATS;
let pingHistory: number[] = [];
let lossHistory: number[] = [];

function numOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pushHistory(arr: number[], value: number | null) {
    if (value == null || !Number.isFinite(value)) return arr;
    const next = [...arr, value];
    if (next.length > HISTORY_LEN) next.shift();
    return next;
}

function scheduleUiSave() {
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        void DataStore.set(UI_STORE_KEY, uiState);
    }, 400);
}

async function loadUiState() {
    const saved = await DataStore.get<UiState>(UI_STORE_KEY);
    if (!saved || typeof saved !== "object") return;
    if (typeof saved.minimized === "boolean") uiState.minimized = saved.minimized;
    if (typeof saved.maximized === "boolean") uiState.maximized = saved.maximized;
    if (saved.pos && typeof saved.pos.left === "number" && typeof saved.pos.top === "number")
        uiState.pos = { left: saved.pos.left, top: saved.pos.top };
}

/** Local user's own voice connection only. */
function collectSelfStats(): SelfStats {
    try {
        const channelId =
            SelectedChannelStore.getVoiceChannelId?.() ??
            RTCConnectionStore.getChannelId?.() ??
            undefined;

        const rtcState = String(RTCConnectionStore.getState?.() ?? "");
        const connected = !!RTCConnectionStore.isConnected?.();
        const reconnecting =
            /CONNECTING|AUTHENTICATING|AWAITING|ICE|DTLS|RTC_DISCONNECTED|NO_ROUTE/i.test(rtcState) &&
            !connected;

        if (!channelId && !connected && !reconnecting) {
            pingHistory = [];
            lossHistory = [];
            return EMPTY_STATS;
        }

        const channel = channelId ? ChannelStore.getChannel(channelId) : null;
        const voiceStates = channelId
            ? (VoiceStateStore.getVoiceStatesForChannel?.(channelId) ?? {})
            : {};
        const peerCount = Math.max(0, Object.keys(voiceStates).length - 1);

        const mes = MediaEngineStore as any;
        const selfId = UserStore.getCurrentUser?.()?.id;
        let speaking = false;
        try {
            if (selfId && typeof mes.isSpeaking === "function")
                speaking = !!mes.isSpeaking(selfId);
            if (!speaking && mes.getSpeakingWhileMuted?.())
                speaking = true;
        } catch { /* ignore */ }

        const selfVs = selfId ? VoiceStateStore.getVoiceStateForUser?.(selfId) : undefined;
        const video = !!(mes.isSelfVideoEnabled?.() ?? mes.isVideoEnabled?.() ?? selfVs?.selfVideo);
        const streaming = !!(mes.isSelfStreaming?.() ?? mes.isStreaming?.() ?? selfVs?.selfStream);
        const muted = !!(mes.isSelfMute?.() ?? selfVs?.selfMute);
        const deafened = !!(mes.isSelfDeaf?.() ?? selfVs?.selfDeaf);

        const mode = streaming ? "Streaming" : video ? "Video" : "Voice";

        const ping =
            numOrNull(RTCConnectionStore.getAveragePing?.()) ??
            numOrNull(RTCConnectionStore.getLastPing?.());

        let loss = numOrNull(RTCConnectionStore.getOutboundLossRate?.());
        if (loss != null && loss <= 1) loss *= 100;

        const ps = RTCConnectionStore.getPacketStats?.();
        if (loss == null && ps && typeof ps.outbound === "number" && typeof ps.lost === "number")
            loss = (ps.lost / Math.max(1, ps.outbound + ps.lost)) * 100;

        const qualityRaw = RTCConnectionStore.getQuality?.();
        const quality = qualityRaw && qualityRaw !== "unknown"
            ? String(qualityRaw)
            : connected
                ? "connected"
                : reconnecting
                    ? "reconnecting"
                    : "-";

        const host = RTCConnectionStore.getHostname?.();
        const hostname = host && String(host).trim() ? String(host) : "-";

        const conn = RTCConnectionStore.getRTCConnection?.() as any;
        const jitterMs =
            numOrNull(conn?.jitter) ??
            numOrNull(conn?.jitterBufferMs) ??
            numOrNull(conn?.stats?.jitter) ??
            null;

        let bitrateKbps =
            numOrNull(conn?.bitrate) ??
            numOrNull(conn?.audioBitrate) ??
            numOrNull(conn?.outboundBitrate) ??
            numOrNull(mes.getVoiceBitRate?.()) ??
            numOrNull(mes.getBitRate?.()) ??
            null;
        if (bitrateKbps != null && bitrateKbps > 1000) bitrateKbps /= 1000;

        const pings = RTCConnectionStore.getPings?.();
        if (Array.isArray(pings) && pings.length) {
            pingHistory = pings
                .map(n => numOrNull(n))
                .filter((n): n is number => n != null)
                .slice(-HISTORY_LEN);
        } else {
            pingHistory = pushHistory(pingHistory, ping);
        }
        lossHistory = pushHistory(lossHistory, loss);

        return {
            channelName: channel?.name || (channelId ? "Voice channel" : "-"),
            peerCount,
            mode,
            quality,
            rttMs: ping,
            packetLossPct: loss,
            jitterMs,
            bitrateKbps,
            hostname,
            connected,
            reconnecting,
            speaking: !!speaking,
            video,
            streaming,
            muted,
            deafened,
            state: rtcState || (connected ? "RTC_CONNECTED" : "-"),
            packetsIn: numOrNull(ps?.inbound),
            packetsOut: numOrNull(ps?.outbound),
            packetsLost: numOrNull(ps?.lost),
            pingHistory: [...pingHistory],
            lossHistory: [...lossHistory]
        };
    } catch {
        return EMPTY_STATS;
    }
}

function fmt(value: number | null, suffix: string, digits = 0) {
    return value === null ? "-" : `${value.toFixed(digits)}${suffix}`;
}

function clampPos(left: number, top: number, w: number, h: number) {
    const maxL = Math.max(8, window.innerWidth - w - 8);
    const maxT = Math.max(8, window.innerHeight - h - 8);
    return {
        left: Math.min(Math.max(8, left), maxL),
        top: Math.min(Math.max(8, top), maxT)
    };
}

function defaultPos(w: number, h: number) {
    return clampPos(window.innerWidth - w - 18, window.innerHeight - h - 88, w, h);
}

function onResize() {
    if (uiState.maximized) {
        paint();
        return;
    }
    const el = document.getElementById(ROOT_ID);
    const w = el?.offsetWidth || 340;
    const h = el?.offsetHeight || 360;
    uiState.pos = clampPos(uiState.pos.left, uiState.pos.top, w, h);
    scheduleUiSave();
    paint();
}

function paint() {
    root?.render(
        <IpaWindow
            ui={uiState}
            dragging={dragging}
            stats={stats}
        />
    );
}

function Sparkline({ values, color }: { values: number[]; color: string; }) {
    if (!values.length) {
        return <div className="vc-ipa-spark vc-ipa-spark-empty">No history yet</div>;
    }
    const w = 280;
    const h = 44;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    const pts = values.map((v, i) => {
        const x = values.length === 1 ? 0 : (i / (values.length - 1)) * w;
        const y = h - ((v - min) / span) * (h - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    return (
        <svg className="vc-ipa-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
            <polyline
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={pts}
            />
        </svg>
    );
}

function Badge({ on, label }: { on: boolean; label: string; }) {
    return (
        <span className={"vc-ipa-badge" + (on ? " is-on" : "")}>{label}</span>
    );
}

function IpaWindow({
    ui,
    dragging: isDrag,
    stats: s
}: {
    ui: UiState;
    dragging: boolean;
    stats: SelfStats;
}) {
    const min = ui.minimized;
    const max = ui.maximized;
    const style = max
        ? { left: 12, top: 12, width: "calc(100vw - 24px)", height: "calc(100vh - 24px)" }
        : { left: ui.pos.left, top: ui.pos.top };

    return (
        <div
            id={ROOT_ID}
            className={[
                "vc-ipa-root",
                min ? "is-min" : "",
                max ? "is-max" : "",
                isDrag ? "is-dragging" : "",
                s.connected ? "is-live" : "",
                s.reconnecting ? "is-reconnect" : ""
            ].filter(Boolean).join(" ")}
            style={style}
            role="dialog"
            aria-label="Internet Protocol Assessment"
        >
            <div className="vc-ipa-card">
                <header
                    className="vc-ipa-bar"
                    onPointerDown={e => {
                        if (max) return;
                        const t = e.target as HTMLElement;
                        if (t.closest("button")) return;
                        dragging = true;
                        dragOffset = { x: e.clientX - uiState.pos.left, y: e.clientY - uiState.pos.top };
                        paint();
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                    }}
                    onPointerMove={e => {
                        if (!dragging || max) return;
                        const el = document.getElementById(ROOT_ID);
                        const w = el?.offsetWidth || 320;
                        const h = el?.offsetHeight || 280;
                        uiState.pos = clampPos(
                            e.clientX - dragOffset.x,
                            e.clientY - dragOffset.y,
                            w,
                            h
                        );
                        paint();
                    }}
                    onPointerUp={() => {
                        if (!dragging) return;
                        dragging = false;
                        scheduleUiSave();
                        paint();
                    }}
                >
                    <div className="vc-ipa-title-wrap">
                        <span className="vc-ipa-mark" aria-hidden="true" />
                        <div className="vc-ipa-titles">
                            <span className="vc-ipa-title">Internet Protocol Assessment</span>
                            <span className="vc-ipa-sub">
                                {s.reconnecting
                                    ? "Reconnecting..."
                                    : s.connected
                                        ? "Live - your connection"
                                        : "Join voice to see stats"}
                            </span>
                        </div>
                    </div>
                    <div className="vc-ipa-actions">
                        <button
                            type="button"
                            className="vc-ipa-btn"
                            title={min ? "Expand" : "Minimize"}
                            aria-label={min ? "Expand" : "Minimize"}
                            onClick={() => {
                                uiState.minimized = !uiState.minimized;
                                if (!uiState.minimized) uiState.maximized = false;
                                scheduleUiSave();
                                paint();
                            }}
                        >
                            {min ? "□" : "–"}
                        </button>
                        <button
                            type="button"
                            className="vc-ipa-btn"
                            title={max ? "Restore" : "Maximize"}
                            aria-label={max ? "Restore" : "Maximize"}
                            disabled={min}
                            onClick={() => {
                                uiState.maximized = !uiState.maximized;
                                if (uiState.maximized) uiState.minimized = false;
                                scheduleUiSave();
                                paint();
                            }}
                        >
                            {max ? "❐" : "▢"}
                        </button>
                        <button
                            type="button"
                            className="vc-ipa-btn vc-ipa-btn-close"
                            title="Close"
                            aria-label="Close"
                            onClick={() => {
                                settings.store.showOverlay = false;
                                teardownUi();
                            }}
                        >
                            ×
                        </button>
                    </div>
                </header>

                {!min && (
                    <div className="vc-ipa-body">
                        <section className="vc-ipa-panel">
                            <h2 className="vc-ipa-heading">Session</h2>
                            <div className="vc-ipa-badges">
                                <Badge on={s.speaking} label="Speaking" />
                                <Badge on={s.video} label="Video" />
                                <Badge on={s.streaming} label="Stream" />
                                <Badge on={s.muted} label="Muted" />
                                <Badge on={s.deafened} label="Deafened" />
                                <Badge on={s.reconnecting} label="Reconnect" />
                            </div>
                            <div className="vc-ipa-grid">
                                <StatRow label="Channel" value={s.channelName} />
                                <StatRow label="Other peers" value={String(s.peerCount)} />
                                <StatRow label="Mode" value={s.mode} />
                                <StatRow label="RTC state" value={s.state} />
                            </div>
                        </section>

                        <section className="vc-ipa-panel">
                            <h2 className="vc-ipa-heading">Your connection</h2>
                            <div className="vc-ipa-grid">
                                <StatRow label="RTT" value={fmt(s.rttMs, " ms")} />
                                <StatRow label="Jitter" value={fmt(s.jitterMs, " ms", 1)} />
                                <StatRow label="Packet loss" value={fmt(s.packetLossPct, "%", 1)} />
                                <StatRow label="Bitrate" value={fmt(s.bitrateKbps, " kbps")} />
                                <StatRow label="Quality" value={s.quality} />
                                <StatRow label="Voice server" value={s.hostname} />
                                <StatRow label="Packets in" value={s.packetsIn == null ? "-" : String(s.packetsIn)} />
                                <StatRow label="Packets out" value={s.packetsOut == null ? "-" : String(s.packetsOut)} />
                                <StatRow label="Packets lost" value={s.packetsLost == null ? "-" : String(s.packetsLost)} />
                            </div>
                        </section>

                        <section className="vc-ipa-panel">
                            <h2 className="vc-ipa-heading">RTT history</h2>
                            <Sparkline values={s.pingHistory} color="#5865f2" />
                        </section>

                        <section className="vc-ipa-panel">
                            <h2 className="vc-ipa-heading">Loss history</h2>
                            <Sparkline values={s.lossHistory} color="#f23f43" />
                        </section>
                    </div>
                )}
            </div>
        </div>
    );
}

function StatRow({ label, value }: { label: string; value: string; }) {
    const isPlaceholder = value === "-";
    return (
        <div className="vc-ipa-row">
            <span className="vc-ipa-label">{label}</span>
            <span className={"vc-ipa-value" + (isPlaceholder ? " vc-ipa-bone" : "")}>{value}</span>
        </div>
    );
}

function refreshStats() {
    stats = collectSelfStats();
    paint();
}

async function ensureUi() {
    if (!settings.store.showOverlay) {
        teardownUi();
        return;
    }
    if (mount && document.body.contains(mount)) {
        refreshStats();
        return;
    }
    teardownUi(false);
    mount = document.createElement("div");
    mount.id = "vc-ipa-host";
    document.body.appendChild(mount);
    root = createRoot(mount);

    if (!uiState.pos.left && !uiState.pos.top)
        uiState.pos = defaultPos(340, 420);
    else
        uiState.pos = clampPos(uiState.pos.left, uiState.pos.top, 340, 360);

    if (!resizeBound) {
        window.addEventListener("resize", onResize);
        resizeBound = true;
    }

    refreshStats();
    pollHandle = setInterval(refreshStats, 1000);
}

function teardownUi(clearResize = true) {
    if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
    }
    if (clearResize && resizeBound) {
        window.removeEventListener("resize", onResize);
        resizeBound = false;
    }
    root?.unmount();
    root = null;
    mount?.remove();
    mount = null;
    dragging = false;
    stats = EMPTY_STATS;
}

export default definePlugin({
    name: "Internet Protocol Assessment",
    description: "Floating overlay for your own Discord voice connection stats, including RTT, packet loss, quality, and server hostname.",
    tags: ["Utility", "Appearance"],
    searchTerms: ["ipa", "ping", "rtt", "voice", "connection", "overlay", "jitter", "bitrate"],
    authors: [Delexo],
    settings,
    managedStyle,

    async start() {
        await loadUiState();
        await ensureUi();
    },

    stop() {
        if (saveTimer != null) clearTimeout(saveTimer);
        void DataStore.set(UI_STORE_KEY, uiState);
        teardownUi();
    }
});
