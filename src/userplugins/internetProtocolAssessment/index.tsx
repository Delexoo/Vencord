/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Floating overlay for this Discord client and this PC's network.
 * Optional localhost Wireshark/TShark summaries, GeoIP of endpoints/RTC
 * servers (not other people's GPS), and enrolled-device labels only.
 */

import { Delexo } from "../_delexo/author";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import {
    Button,
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

const Native = VencordNative.pluginHelpers["Internet Protocol Assessment"] as PluginNative<typeof import("./native")> | undefined;

const ROOT_ID = "vc-ipa-root";
const UI_STORE_KEY = "IpaUiState";
const HISTORY_LEN = 48;

function native() {
    return Native;
}

function OpenIpaFolders() {
    const open = (key: string) => { void native()?.openFolder(key); };
    return (
        <div className="vc-ipa-folder-btns">
            <Button size={Button.Sizes.SMALL} onClick={() => open("plugin")}>Plugin folder</Button>
            <Button size={Button.Sizes.SMALL} onClick={() => open("captures")}>Wireshark captures</Button>
            <Button size={Button.Sizes.SMALL} onClick={() => open("settings")}>Vencord settings</Button>
            <Button size={Button.Sizes.SMALL} onClick={() => open("log")}>Bridge log folder</Button>
            <Button size={Button.Sizes.SMALL} onClick={() => open("appDataDist")}>AppData dist</Button>
            <Button size={Button.Sizes.SMALL} onClick={() => open("delexooDist")}>Delexoo dist</Button>
        </div>
    );
}

const settings = definePluginSettings({
    wiresharkBridgeUrl: {
        type: OptionType.STRING,
        description: "Local Wireshark bridge URL (127.0.0.1 or private LAN)",
        default: "http://127.0.0.1:8765"
    },
    deviceBBridgeUrl: {
        type: OptionType.STRING,
        description: "Optional Device B bridge URL on your LAN",
        default: ""
    },
    bridgeToken: {
        type: OptionType.STRING,
        description: "Optional shared token for the local bridge",
        default: ""
    },
    captureInterface: {
        type: OptionType.STRING,
        description: "TShark interface number or name (blank = first non-loopback)",
        default: ""
    },
    bridgeScriptPath: {
        type: OptionType.STRING,
        description: "Optional full path to wireshark_bridge.py",
        default: ""
    },
    geoDbPath: {
        type: OptionType.STRING,
        description: "Optional MaxMind GeoLite2-City.mmdb path",
        default: ""
    },
    authorizedDevicesPath: {
        type: OptionType.STRING,
        description: "JSON map of enrolled test-device IPs to labels (blank uses authorized_devices.example.json)",
        default: ""
    },
    showOverlay: {
        type: OptionType.BOOLEAN,
        description: "Show the floating connection overlay",
        default: true,
        onChange(v: boolean) {
            if (v) void ensureUi();
            else teardownUi();
        }
    },
    openFolders: {
        type: OptionType.COMPONENT,
        description: "Open related folders on this PC",
        component: OpenIpaFolders
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
    transportProtocol: string;
    dtlsState: string;
    dtlsCipher: string;
    srtpCipher: string;
    selectedCandidateState: string;
    localCandidateProtocol: string;
    remoteCandidateProtocol: string;
    remoteEndpoint: string;
    audioCodecs: string[];
    payloadInspection: string;
    participants: Array<{ id: string; name: string; }>;
}


interface CapturedConnection {
    transport?: string;
    protocol: string;
    src: string;
    dst: string;
    sport: number | null;
    dport: number | null;
    streamId?: string | null;
    packets: number;
    bytes: number;
    firstSeen: string;
    lastSeen: string;
    encrypted: string;
    srcLocation: string;
    dstLocation: string;
    srcGeo?: {
        scope: string;
        city: string | null;
        region: string | null;
        country: string | null;
        countryCode: string | null;
        latitude: number | null;
        longitude: number | null;
    };
    tcpRetransmissions?: number;
    tcpFastRetransmissions?: number;
    duplicateAcks?: number;
    outOfOrder?: number;
    minDeltaMs?: number | null;
    maxDeltaMs?: number | null;
    lastDeltaMs?: number | null;
    lastInfo?: string;
    tcpFlags?: string | null;
    tcpWindow?: number | null;
    tcpWindowScaled?: number | null;
    tcpBytesInFlight?: number | null;
    minAckRttMs?: number | null;
    maxAckRttMs?: number | null;
    lastAckRttMs?: number | null;
    dscp?: number | null;
    ecn?: number | null;
    fragmentOffset?: number | null;
    dnsRcode?: string | null;
    tlsSni?: string | null;
    tlsAlpn?: string | null;
    quicDcid?: string | null;
    quicScid?: string | null;
    stunType?: string | null;
    stunXorMappedAddress?: string | null;
    stunXorMappedPort?: number | null;
    expertSeverity?: string | null;
    expertMessageCount?: number;
    srcAuthorizedLabel?: string | null;
    dstAuthorizedLabel?: string | null;
    ttl?: number | null;
    hopLimit?: number | null;
    dnsQuery?: string | null;
    tlsVersion?: string | null;
    quicVersion?: string | null;
    dstGeo?: {
        scope: string;
        city: string | null;
        region: string | null;
        country: string | null;
        countryCode: string | null;
        latitude: number | null;
        longitude: number | null;
    };
}



interface CapturedPacketSummary {
    number: number | null;
    time: string;
    relativeMs: number;
    deltaMs: number;
    transport: string;
    protocol: string;
    info: string;
    srcMac: string;
    dstMac: string;
    src: string;
    dst: string;
    sport: number | null;
    dport: number | null;
    length: number;
    capturedLength: number;
    ttl: number | null;
    hopLimit: number | null;
    streamId: string | null;
    tcpFlags: string | null;
    tcpSeq: number | null;
    tcpAck: number | null;
    tcpPayloadBytes: number | null;
    tcpWindow: number | null;
    tcpWindowScaled?: number | null;
    tcpBytesInFlight?: number | null;
    tcpAckRttMs?: number | null;
    dscp?: number | null;
    ecn?: number | null;
    fragmentOffset?: number | null;
    udpLength: number | null;
    dnsQuery: string | null;
    dnsRcode?: string | null;
    tlsVersion: string | null;
    tlsSni?: string | null;
    tlsAlpn?: string | null;
    quicVersion: string | null;
    quicDcid?: string | null;
    quicScid?: string | null;
    stunType?: string | null;
    stunXorMappedAddress?: string | null;
    stunXorMappedPort?: number | null;
    expertSeverity?: string | null;
    srcAuthorizedLabel?: string | null;
    dstAuthorizedLabel?: string | null;
    anomalies: string[];
    security: string;
}

interface VoicePresenceEvent {
    time: string;
    type: "joined" | "left" | "channel";
    userId?: string;
    label: string;
    peerCount: number;
}

let voicePresenceEvents: VoicePresenceEvent[] = [];
let previousVoiceChannelId: string | null = null;
let previousVoicePeerIds = new Set<string>();

function participantLabel(userId: string): string {
    try {
        const user = (UserStore as any).getUser?.(userId);
        return String(
            user?.globalName ??
            user?.displayName ??
            user?.username ??
            `User ${userId.slice(-6)}`
        );
    } catch {
        return `User ${userId.slice(-6)}`;
    }
}

function updateVoicePresenceEvents(
    channelId: string | undefined,
    voiceStates: Record<string, unknown>,
    selfId: string | undefined
) {
    const normalizedChannel = channelId ?? null;
    const currentIds = new Set(
        Object.keys(voiceStates ?? {}).filter(id => id && id !== selfId)
    );

    if (normalizedChannel !== previousVoiceChannelId) {
        previousVoiceChannelId = normalizedChannel;
        previousVoicePeerIds = currentIds;

        if (normalizedChannel) {
            voicePresenceEvents.unshift({
                time: new Date().toISOString(),
                type: "channel",
                label: "Started monitoring this voice channel",
                peerCount: currentIds.size
            });
        }

        voicePresenceEvents = voicePresenceEvents.slice(0, 40);
        return;
    }

    for (const id of currentIds) {
        if (!previousVoicePeerIds.has(id)) {
            voicePresenceEvents.unshift({
                time: new Date().toISOString(),
                type: "joined",
                userId: id,
                label: `${participantLabel(id)} joined`,
                peerCount: currentIds.size
            });
        }
    }

    for (const id of previousVoicePeerIds) {
        if (!currentIds.has(id)) {
            voicePresenceEvents.unshift({
                time: new Date().toISOString(),
                type: "left",
                userId: id,
                label: `${participantLabel(id)} left`,
                peerCount: currentIds.size
            });
        }
    }

    previousVoicePeerIds = currentIds;
    voicePresenceEvents = voicePresenceEvents.slice(0, 40);
}

interface WiresharkSnapshot {
    running: boolean;
    interfaceName: string;
    captureFile: string;
    packetsCaptured: number;
    connections: CapturedConnection[];
    lastError: string | null;
    updatedAt: string;
    geoDatabase?: string;
    geoEnabled?: boolean;
    bytesCaptured?: number;
    startedAt?: string;
    uptimeSeconds?: number;
    packetsPerSecond?: number;
    bitsPerSecond?: number;
    protocolCounters?: Record<string, number>;
    transportCounters?: Record<string, number>;
    recentPackets?: CapturedPacketSummary[];
}

const EMPTY_WIRESHARK: WiresharkSnapshot = {
    running: false,
    interfaceName: "-",
    captureFile: "-",
    packetsCaptured: 0,
    connections: [],
    lastError: null,
    updatedAt: "",
    bytesCaptured: 0,
    startedAt: "",
    uptimeSeconds: 0,
    packetsPerSecond: 0,
    bitsPerSecond: 0,
    protocolCounters: {},
    transportCounters: {},
    recentPackets: []
};

let wiresharkSnapshot: WiresharkSnapshot = EMPTY_WIRESHARK;
let wiresharkHandle: ReturnType<typeof setInterval> | null = null;
let captureBusy = false;
let lastCaptureMessage = "";
let deviceBStatus = "-";

function applySnapshot(next: WiresharkSnapshot) {
    wiresharkSnapshot = {
        ...EMPTY_WIRESHARK,
        ...next,
        connections: Array.isArray(next.connections) ? next.connections.slice(0, 40) : [],
        recentPackets: Array.isArray(next.recentPackets) ? next.recentPackets.slice(-120) : []
    };
}

function overlaySubtitle(s: SelfStats): string {
    if (captureBusy) return "Starting capture...";
    if (lastCaptureMessage && !wiresharkSnapshot.running) return lastCaptureMessage;
    if (wiresharkSnapshot.running) {
        const pps = Number(wiresharkSnapshot.packetsPerSecond ?? 0).toFixed(1);
        return `Live capture · ${pps} pkt/s · ${wiresharkSnapshot.interfaceName}`;
    }
    if (s.reconnecting) return "Reconnecting...";
    if (s.connected) return "Press Start for TShark capture · voice connected";
    return "Press Start to capture this PC · join voice for RTC stats";
}

async function fetchOneSnapshot(base: string, token: string): Promise<WiresharkSnapshot | null> {
    const helper = native();
    if (helper?.fetchSnapshot) {
        const res = await helper.fetchSnapshot(base, token);
        if (res.ok && res.data)
            return JSON.parse(res.data) as WiresharkSnapshot;
        if (res.ok === false && res.error && !/timed out|ECONNREFUSED|fetch/i.test(res.error))
            throw new Error(res.error);
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
        headers["X-Ipa-Token"] = token;
    }
    const url = token ? `${base}/snapshot?token=${encodeURIComponent(token)}` : `${base}/snapshot`;
    const response = await fetch(url, { method: "GET", cache: "no-store", headers });
    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
    return await response.json() as WiresharkSnapshot;
}

async function fetchWiresharkSnapshot() {
    const base = String(settings.store.wiresharkBridgeUrl || "http://127.0.0.1:8765")
        .replace(/\/+$/, "");
    const token = String(settings.store.bridgeToken || "").trim();
    const deviceB = String(settings.store.deviceBBridgeUrl || "").trim().replace(/\/+$/, "");

    try {
        const next = await fetchOneSnapshot(base, token);
        if (next && typeof next === "object")
            applySnapshot(next);
    } catch {
        wiresharkSnapshot = {
            ...EMPTY_WIRESHARK,
            lastError: lastCaptureMessage || null,
            updatedAt: new Date().toISOString()
        };
    }

    if (deviceB && deviceB !== base) {
        try {
            const other = await fetchOneSnapshot(deviceB, token);
            deviceBStatus = other?.running
                ? `Live · ${Number(other.packetsPerSecond ?? 0).toFixed(1)} pkt/s`
                : "Reachable, capture off";
        } catch {
            deviceBStatus = "Offline";
        }
    } else {
        deviceBStatus = "-";
    }

    paint();
}

async function startLocalCapture() {
    const helper = native();
    if (!helper?.startCapture) {
        lastCaptureMessage = "Native helpers need a full Discord restart.";
        paint();
        return;
    }
    captureBusy = true;
    lastCaptureMessage = "";
    paint();
    try {
        const res = await helper.startCapture(
            String(settings.store.wiresharkBridgeUrl || "http://127.0.0.1:8765"),
            String(settings.store.bridgeToken || ""),
            String(settings.store.captureInterface || ""),
            String(settings.store.bridgeScriptPath || ""),
            String(settings.store.geoDbPath || ""),
            String(settings.store.authorizedDevicesPath || "")
        );
        lastCaptureMessage = res.ok ? String(res.data || "Capture started.") : String(res.error || "Capture failed.");
        await fetchWiresharkSnapshot();
    } catch (e) {
        lastCaptureMessage = e instanceof Error ? e.message : String(e);
    } finally {
        captureBusy = false;
        paint();
    }
}

async function stopLocalCapture() {
    const helper = native();
    captureBusy = true;
    paint();
    try {
        await helper?.stopCapture(
            String(settings.store.wiresharkBridgeUrl || "http://127.0.0.1:8765"),
            String(settings.store.bridgeToken || "")
        );
        lastCaptureMessage = "";
        wiresharkSnapshot = { ...EMPTY_WIRESHARK };
    } catch (e) {
        lastCaptureMessage = e instanceof Error ? e.message : String(e);
    } finally {
        captureBusy = false;
        paint();
    }
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
    lossHistory: [],
    transportProtocol: "-",
    dtlsState: "-",
    dtlsCipher: "-",
    srtpCipher: "-",
    selectedCandidateState: "-",
    localCandidateProtocol: "-",
    remoteCandidateProtocol: "-",
    remoteEndpoint: "-",
    audioCodecs: [],
    payloadInspection: "Not performed",
    participants: []
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

/**
 * Safe WebRTC transport inspection.
 *
 * This intentionally uses the browser's WebRTC statistics API only.
 * It does NOT read packet payloads, decrypt media, install packet hooks,
 * capture other users' traffic, or perform a raw socket capture.
 */
async function collectTransportSecurityStats(pc: any): Promise<{
    transportProtocol: string;
    dtlsState: string;
    dtlsCipher: string;
    srtpCipher: string;
    selectedCandidateState: string;
    localCandidateProtocol: string;
    remoteCandidateProtocol: string;
    remoteEndpoint: string;
    audioCodecs: string[];
    packetsIn: number | null;
    packetsOut: number | null;
    packetsLost: number | null;
}> {
    const empty = {
        transportProtocol: "-",
        dtlsState: "-",
        dtlsCipher: "-",
        srtpCipher: "-",
        selectedCandidateState: "-",
        localCandidateProtocol: "-",
        remoteCandidateProtocol: "-",
        remoteEndpoint: "-",
        audioCodecs: [] as string[],
        packetsIn: null,
        packetsOut: null,
        packetsLost: null
    };

    if (!pc || typeof pc.getStats !== "function") return empty;

    try {
        const report = await pc.getStats();
        const stats = [...report.values()] as any[];

        const transport = stats.find(s => s.type === "transport");
        const candidatePair =
            stats.find(s => s.type === "candidate-pair" && (s.selected || s.nominated)) ??
            (transport?.selectedCandidatePairId
                ? stats.find(s => s.id === transport.selectedCandidatePairId)
                : undefined);

        const localCandidate = candidatePair?.localCandidateId
            ? stats.find(s => s.id === candidatePair.localCandidateId)
            : undefined;

        const remoteCandidate = candidatePair?.remoteCandidateId
            ? stats.find(s => s.id === candidatePair.remoteCandidateId)
            : undefined;

        const codecMap = new Map(
            stats
                .filter(s => s.type === "codec" && typeof s.mimeType === "string")
                .map(s => [s.id, s])
        );

        const audioCodecs = [...new Set(
            stats
                .filter(s =>
                    (s.type === "inbound-rtp" || s.type === "outbound-rtp") &&
                    String(s.kind ?? s.mediaType ?? "").toLowerCase() === "audio" &&
                    s.codecId
                )
                .map(s => codecMap.get(s.codecId)?.mimeType)
                .filter((v): v is string => typeof v === "string")
        )];

        const inbound = stats.filter(s =>
            s.type === "inbound-rtp" &&
            String(s.kind ?? s.mediaType ?? "").toLowerCase() === "audio"
        );
        const outbound = stats.filter(s =>
            s.type === "outbound-rtp" &&
            String(s.kind ?? s.mediaType ?? "").toLowerCase() === "audio"
        );

        const packetsIn = inbound.length
            ? inbound.reduce((n, s) => n + (Number(s.packetsReceived) || 0), 0)
            : null;

        const packetsOut = outbound.length
            ? outbound.reduce((n, s) => n + (Number(s.packetsSent) || 0), 0)
            : null;

        const packetsLost = inbound.length
            ? inbound.reduce((n, s) => n + (Number(s.packetsLost) || 0), 0)
            : null;

        const remoteAddress = remoteCandidate?.address ?? remoteCandidate?.ip;
        const remotePort = remoteCandidate?.port;

        return {
            transportProtocol: String(
                localCandidate?.protocol ??
                remoteCandidate?.protocol ??
                candidatePair?.protocol ??
                "-"
            ).toUpperCase(),
            dtlsState: String(
                transport?.dtlsState ??
                pc.sctp?.transport?.state ??
                "-"
            ),
            dtlsCipher: String(transport?.dtlsCipher ?? "-"),
            srtpCipher: String(transport?.srtpCipher ?? "-"),
            selectedCandidateState: String(candidatePair?.state ?? "-"),
            localCandidateProtocol: String(localCandidate?.protocol ?? "-").toUpperCase(),
            remoteCandidateProtocol: String(remoteCandidate?.protocol ?? "-").toUpperCase(),
            remoteEndpoint: remoteAddress
                ? `${remoteAddress}${remotePort ? `:${remotePort}` : ""}`
                : "-",
            audioCodecs,
            packetsIn,
            packetsOut,
            packetsLost
        };
    } catch {
        return empty;
    }
}

/** Local user's own voice connection only. */
async function collectSelfStats(): Promise<SelfStats> {
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
        updateVoicePresenceEvents(channelId, voiceStates, selfId);

        const participants = Object.keys(voiceStates)
            .filter(id => id && id !== selfId)
            .map(id => ({ id, name: participantLabel(id) }));

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
        const transportStats = await collectTransportSecurityStats(conn);

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
            packetsIn: transportStats.packetsIn ?? numOrNull(ps?.inbound),
            packetsOut: transportStats.packetsOut ?? numOrNull(ps?.outbound),
            packetsLost: transportStats.packetsLost ?? numOrNull(ps?.lost),
            pingHistory: [...pingHistory],
            lossHistory: [...lossHistory],
            transportProtocol: transportStats.transportProtocol,
            dtlsState: transportStats.dtlsState,
            dtlsCipher: transportStats.dtlsCipher,
            srtpCipher: transportStats.srtpCipher,
            selectedCandidateState: transportStats.selectedCandidateState,
            localCandidateProtocol: transportStats.localCandidateProtocol,
            remoteCandidateProtocol: transportStats.remoteCandidateProtocol,
            remoteEndpoint: transportStats.remoteEndpoint,
            audioCodecs: transportStats.audioCodecs,
            payloadInspection: "Not performed",
            participants
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


function scoreVoiceFlow(c: CapturedConnection): number {
    const transport = String(c.transport || "").toUpperCase();
    const protocol = String(c.protocol || "").toUpperCase();
    let score = 0;

    if (transport === "UDP") score += 5;
    if (["DTLS", "RTP", "RTCP", "SRTP", "QUIC"].includes(protocol)) score += 8;
    if (c.encrypted === "Encrypted transport") score += 3;
    score += Math.min(c.packets / 1000, 5);

    return score;
}

function getPrimaryVoiceFlow(): CapturedConnection | null {
    return [...(wiresharkSnapshot.connections ?? [])]
        .sort((a, b) => scoreVoiceFlow(b) - scoreVoiceFlow(a))[0] ?? null;
}

function endpointText(flow: CapturedConnection | null): string {
    if (!flow) return "No active endpoint";
    const port = flow.dport ?? flow.sport;
    return `${flow.dst}${port != null ? `:${port}` : ""}`;
}

function regionText(flow: CapturedConnection | null): string {
    if (!flow) return "Unknown";
    return flow.dstLocation || flow.srcLocation || "Unknown";
}


function fmtBytes(value: number | undefined): string {
    const n = Number(value ?? 0);
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MiB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${Math.round(n)} B`;
}

function fmtRate(value: number | undefined): string {
    const n = Number(value ?? 0);
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} Gb/s`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} Mb/s`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)} kb/s`;
    return `${Math.round(n)} b/s`;
}

function topCounters(counter: Record<string, number> | undefined, limit = 8): Array<[string, number]> {
    return Object.entries(counter ?? {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function ParticipantCard({
    participant,
    peerCount
}: {
    participant: { id: string; name: string; };
    peerCount: number;
}) {
    const flow = getPrimaryVoiceFlow();

    return (
        <div className="vc-ipa-user-card" tabIndex={0}>
            <span className="vc-ipa-user-presence" aria-hidden="true" />
            <div className="vc-ipa-user-copy">
                <strong>{participant.name}</strong>
                <span>Connected to voice</span>
            </div>

            <div className="vc-ipa-user-tooltip" role="tooltip">
                <div className="vc-ipa-tooltip-head">
                    <strong>{participant.name}</strong>
                    <span>Voice participant</span>
                </div>

                <div className="vc-ipa-tooltip-grid">
                    <span>Name</span><strong>{participant.name}</strong>
                    <span>User ID</span><code>{participant.id}</code>
                    <span>Peers</span><strong>{peerCount}</strong>
                    <span>Observed endpoint</span><code>{endpointText(flow)}</code>
                    <span>Authorized label</span><strong>{flow?.dstAuthorizedLabel || flow?.srcAuthorizedLabel || "Not enrolled"}</strong>
                    <span>Regional area</span><strong>{regionText(flow)}</strong>
                    <span>Transport</span><strong>{flow ? `${flow.transport || "IP"} / ${flow.protocol}` : "Unknown"}</strong>
                    <span>Packets</span><strong>{flow ? String(flow.packets) : "-"}</strong>
                    <span>Inter-packet Δ</span><strong>{flow?.lastDeltaMs != null ? `${flow.lastDeltaMs.toFixed(3)} ms` : "-"}</strong>
                    <span>TCP ACK RTT</span><strong>{flow?.lastAckRttMs != null ? `${flow.lastAckRttMs.toFixed(3)} ms` : "-"}</strong>
                    <span>Bytes in flight</span><strong>{flow?.tcpBytesInFlight ?? "-"}</strong>
                    <span>Retransmissions</span><strong>{flow?.tcpRetransmissions ?? 0}</strong>
                    <span>Dup ACK / OOO</span><strong>{`${flow?.duplicateAcks ?? 0} / ${flow?.outOfOrder ?? 0}`}</strong>
                    <span>TTL / Hop limit</span><strong>{flow?.ttl ?? flow?.hopLimit ?? "-"}</strong>
                    <span>Security</span><strong>{flow?.encrypted || "Unknown"}</strong>
                </div>

                <p className="vc-ipa-tooltip-warning">
                    IP and region describe the voice-network endpoint visible to your client.
                    Discord can use shared RTC/relay infrastructure, so this is not asserted
                    to be this participant's personal IP or physical location.
                </p>
            </div>
        </div>
    );
}

function ProtocolBadge({ value }: { value: string; }) {
    return <span className={`vc-ipa-proto vc-ipa-proto-${String(value).toLowerCase()}`}>{value}</span>;
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
                s.connected || wiresharkSnapshot.running ? "is-live" : "",
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
                            <span className="vc-ipa-sub">{overlaySubtitle(s)}</span>
                        </div>
                    </div>
                    <div className="vc-ipa-actions">
                        <button
                            type="button"
                            className={"vc-ipa-btn vc-ipa-btn-start" + (wiresharkSnapshot.running ? " is-stop" : "")}
                            title={wiresharkSnapshot.running ? "Stop capture" : "Start capture"}
                            aria-label={wiresharkSnapshot.running ? "Stop capture" : "Start capture"}
                            disabled={captureBusy}
                            onClick={() => {
                                void (wiresharkSnapshot.running ? stopLocalCapture() : startLocalCapture());
                            }}
                        >
                            {captureBusy ? "..." : wiresharkSnapshot.running ? "Stop" : "Start"}
                        </button>
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
                    <div className="vc-ipa-body vc-ipa-tech-body">
                        <section className="vc-ipa-top-grid">
                            <div className="vc-ipa-panel vc-ipa-session-overview">
                                <div className="vc-ipa-section-head">
                                    <div>
                                        <span className="vc-ipa-eyebrow">VOICE SESSION</span>
                                        <h2 className="vc-ipa-heading">{s.channelName}</h2>
                                    </div>
                                    <span className={"vc-ipa-status-pill" + (s.connected ? " is-ok" : s.reconnecting ? " is-warn" : "")}>
                                        {s.connected ? "CONNECTED" : s.reconnecting ? "RECONNECTING" : "IDLE"}
                                    </span>
                                </div>

                                <div className="vc-ipa-kpis">
                                    <div className="vc-ipa-kpi"><span>Peers</span><strong>{s.peerCount}</strong></div>
                                    <div className="vc-ipa-kpi"><span>RTT</span><strong>{fmt(s.rttMs, " ms")}</strong></div>
                                    <div className="vc-ipa-kpi"><span>Jitter</span><strong>{fmt(s.jitterMs, " ms", 1)}</strong></div>
                                    <div className="vc-ipa-kpi"><span>Loss</span><strong>{fmt(s.packetLossPct, "%", 1)}</strong></div>
                                    <div className="vc-ipa-kpi"><span>Bitrate</span><strong>{fmt(s.bitrateKbps, " kbps")}</strong></div>
                                </div>

                                <div className="vc-ipa-badges">
                                    <Badge on={s.speaking} label="Speaking" />
                                    <Badge on={s.video} label="Video" />
                                    <Badge on={s.streaming} label="Stream" />
                                    <Badge on={s.muted} label="Muted" />
                                    <Badge on={s.deafened} label="Deafened" />
                                </div>
                            </div>

                            <div className="vc-ipa-panel">
                                <div className="vc-ipa-section-head">
                                    <div>
                                        <span className="vc-ipa-eyebrow">TRANSPORT SECURITY</span>
                                        <h2 className="vc-ipa-heading">RTC / ICE / DTLS</h2>
                                    </div>
                                </div>
                                <div className="vc-ipa-grid vc-ipa-grid-technical">
                                    <StatRow label="RTC state" value={s.state} />
                                    <StatRow label="Transport" value={s.transportProtocol} />
                                    <StatRow label="DTLS state" value={s.dtlsState} />
                                    <StatRow label="DTLS cipher" value={s.dtlsCipher} />
                                    <StatRow label="SRTP cipher" value={s.srtpCipher} />
                                    <StatRow label="ICE candidate" value={s.selectedCandidateState} />
                                    <StatRow label="Local candidate" value={s.localCandidateProtocol} />
                                    <StatRow label="Remote candidate" value={s.remoteCandidateProtocol} />
                                    <StatRow label="Remote endpoint" value={s.remoteEndpoint} />
                                    <StatRow label="Audio codecs" value={s.audioCodecs.length ? s.audioCodecs.join(", ") : "-"} />
                                </div>
                            </div>
                        </section>

                        <section className="vc-ipa-panel">
                            <div className="vc-ipa-section-head">
                                <div>
                                    <span className="vc-ipa-eyebrow">PARTICIPANTS</span>
                                    <h2 className="vc-ipa-heading">Users in voice</h2>
                                </div>
                                <span className="vc-ipa-count-pill">{s.participants.length}</span>
                            </div>

                            <div className="vc-ipa-user-grid">
                                {s.participants.length
                                    ? s.participants.map(participant => (
                                        <ParticipantCard
                                            key={participant.id}
                                            participant={participant}
                                            peerCount={s.peerCount}
                                        />
                                    ))
                                    : <div className="vc-ipa-empty">No other participant is currently in voice.</div>}
                            </div>

                            <div className="vc-ipa-panel-note">
                                Hover or keyboard-focus a user for their Discord name/ID plus the currently observed voice-network endpoint.
                            </div>
                        </section>

                        <section className="vc-ipa-panel">
                            <div className="vc-ipa-section-head">
                                <div>
                                    <span className="vc-ipa-eyebrow">NETWORK FORENSICS</span>
                                    <h2 className="vc-ipa-heading">Wireshark / TShark live packet telemetry</h2>
                                </div>
                                <span className={"vc-ipa-status-pill" + (wiresharkSnapshot.running ? " is-ok" : "")}>
                                    {wiresharkSnapshot.running ? "CAPTURE ACTIVE" : "CAPTURE OFFLINE"}
                                </span>
                            </div>

                            <div className="vc-ipa-forensic-kpis">
                                <div className="vc-ipa-kpi"><span>Total frames</span><strong>{wiresharkSnapshot.packetsCaptured}</strong></div>
                                <div className="vc-ipa-kpi"><span>Captured bytes</span><strong>{fmtBytes(wiresharkSnapshot.bytesCaptured)}</strong></div>
                                <div className="vc-ipa-kpi"><span>Packet rate</span><strong>{Number(wiresharkSnapshot.packetsPerSecond ?? 0).toFixed(1)} pps</strong></div>
                                <div className="vc-ipa-kpi"><span>Average wire rate</span><strong>{fmtRate(wiresharkSnapshot.bitsPerSecond)}</strong></div>
                                <div className="vc-ipa-kpi"><span>Flows</span><strong>{wiresharkSnapshot.connections.length}</strong></div>
                            </div>

                            <div className="vc-ipa-capture-meta">
                                <StatRow label="Capture interface" value={wiresharkSnapshot.interfaceName} />
                                <StatRow label="PCAPNG archive" value={wiresharkSnapshot.captureFile} />
                                <StatRow label="GeoIP database" value={wiresharkSnapshot.geoEnabled ? (wiresharkSnapshot.geoDatabase || "Enabled") : "Disabled"} />
                                <StatRow label="Capture uptime" value={`${Number(wiresharkSnapshot.uptimeSeconds ?? 0).toFixed(1)} s`} />
                                <StatRow label="Last bridge update" value={wiresharkSnapshot.updatedAt || "-"} />
                                <StatRow label="Device B bridge" value={deviceBStatus} />
                                <StatRow label="Bridge fault" value={wiresharkSnapshot.lastError || lastCaptureMessage || "None"} />
                            </div>

                            <div className="vc-ipa-protocol-columns">
                                <div>
                                    <span className="vc-ipa-eyebrow">L4 DISTRIBUTION</span>
                                    <div className="vc-ipa-counter-list">
                                        {topCounters(wiresharkSnapshot.transportCounters).map(([name, count]) => (
                                            <div className="vc-ipa-counter-row" key={name}>
                                                <ProtocolBadge value={name} />
                                                <strong>{count}</strong>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <span className="vc-ipa-eyebrow">DISSECTOR / APPLICATION PROTOCOLS</span>
                                    <div className="vc-ipa-counter-list">
                                        {topCounters(wiresharkSnapshot.protocolCounters).map(([name, count]) => (
                                            <div className="vc-ipa-counter-row" key={name}>
                                                <ProtocolBadge value={name} />
                                                <strong>{count}</strong>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="vc-ipa-table-scroll">
                                <div className="vc-ipa-flow-table vc-ipa-flow-table-deep">
                                    <div className="vc-ipa-flow-header">
                                        <span>L4 / App</span>
                                        <span>Source endpoint</span>
                                        <span>Destination endpoint</span>
                                        <span>Stream</span>
                                        <span>Pkts / Bytes</span>
                                        <span>Δ / ACK RTT</span>
                                        <span>TCP analysis</span>
                                        <span>IP QoS</span>
                                        <span>ICE/STUN</span>
                                        <span>GeoIP / auth</span>
                                        <span>TLS / QUIC / security</span>
                                    </div>

                                    {wiresharkSnapshot.connections.length
                                        ? wiresharkSnapshot.connections.slice(0, 40).map((c, i) => (
                                            <div className="vc-ipa-flow-row" key={`${c.src}-${c.dst}-${c.protocol}-${c.streamId}-${i}`}>
                                                <span className="vc-ipa-flow-protocol">
                                                    <ProtocolBadge value={c.transport || "IP"} />
                                                    <ProtocolBadge value={c.protocol || "OTHER"} />
                                                </span>
                                                <code title={c.src}>{c.src}:{c.sport ?? "-"}</code>
                                                <code title={c.dst}>{c.dst}:{c.dport ?? "-"}</code>
                                                <code>{c.streamId ?? "-"}</code>
                                                <span>{c.packets} / {fmtBytes(c.bytes)}</span>
                                                <span>{c.lastDeltaMs != null ? `${c.lastDeltaMs.toFixed(3)} ms` : "-"} / {c.lastAckRttMs != null ? `${c.lastAckRttMs.toFixed(3)} ms` : "-"}</span>
                                                <span title={c.lastInfo || ""}>
                                                    R:{c.tcpRetransmissions ?? 0} F:{c.tcpFastRetransmissions ?? 0} D:{c.duplicateAcks ?? 0} O:{c.outOfOrder ?? 0} · Win:{c.tcpWindowScaled ?? c.tcpWindow ?? "-"} · BIF:{c.tcpBytesInFlight ?? "-"}
                                                </span>
                                                <span>TTL:{c.ttl ?? c.hopLimit ?? "-"} DSCP:{c.dscp ?? "-"} ECN:{c.ecn ?? "-"} Frag:{c.fragmentOffset ?? 0}</span>
                                                <span>{c.stunType || "-"} {c.stunXorMappedAddress ? `· ${c.stunXorMappedAddress}:${c.stunXorMappedPort ?? "-"}` : ""}</span>
                                                <span>{c.dstAuthorizedLabel || c.srcAuthorizedLabel || c.dstLocation || c.srcLocation || "Unknown"}</span>
                                                <span>{c.encrypted}{c.tlsVersion ? ` · TLS ${c.tlsVersion}` : ""}{c.tlsSni ? ` · SNI ${c.tlsSni}` : ""}{c.tlsAlpn ? ` · ALPN ${c.tlsAlpn}` : ""}{c.quicVersion ? ` · QUIC ${c.quicVersion}` : ""}</span>
                                            </div>
                                        ))
                                        : <div className="vc-ipa-empty">No decoded packet flows received from the localhost bridge.</div>}
                                </div>
                            </div>

                            <div className="vc-ipa-panel-note">
                                The PCAPNG file is the complete packet capture. This table exposes deep decoded metadata without attempting to deanonymize unrelated participants.
                                GeoIP identifies public endpoints/RTC infrastructure, not participant GPS data. Use --authorized-devices to label IPs for devices you own or are authorized to test.
                            </div>
                        </section>

                        <section className="vc-ipa-panel">
                            <div className="vc-ipa-section-head">
                                <div>
                                    <span className="vc-ipa-eyebrow">FRAME LOG</span>
                                    <h2 className="vc-ipa-heading">Recent decoded packets</h2>
                                </div>
                                <span className="vc-ipa-count-pill">{wiresharkSnapshot.recentPackets?.length ?? 0}</span>
                            </div>

                            <div className="vc-ipa-table-scroll">
                                <div className="vc-ipa-packet-table">
                                    <div className="vc-ipa-packet-header">
                                        <span>No.</span><span>Δ ms</span><span>Protocol</span><span>Source</span><span>Destination</span>
                                        <span>Len</span><span>Flags / Seq / Ack</span><span>Analysis / Info</span>
                                    </div>

                                    {[...(wiresharkSnapshot.recentPackets ?? [])].reverse().slice(0, 120).map((p, i) => (
                                        <div className="vc-ipa-packet-row" key={`${p.number ?? i}-${p.time}`}>
                                            <code>{p.number ?? "-"}</code>
                                            <span>{Number(p.deltaMs ?? 0).toFixed(3)}</span>
                                            <span className="vc-ipa-flow-protocol">
                                                <ProtocolBadge value={p.transport || "IP"} />
                                                <ProtocolBadge value={p.protocol || "OTHER"} />
                                            </span>
                                            <code title={`${p.srcMac} · ${p.src}`}>{p.src}:{p.sport ?? "-"}</code>
                                            <code title={`${p.dstMac} · ${p.dst}`}>{p.dst}:{p.dport ?? "-"}</code>
                                            <span>{p.length}</span>
                                            <code>{p.tcpFlags || "-"} · S:{p.tcpSeq ?? "-"} A:{p.tcpAck ?? "-"} · RTT:{p.tcpAckRttMs != null ? `${p.tcpAckRttMs.toFixed(3)}ms` : "-"}</code>
                                            <span title={p.info}>{p.anomalies?.length ? `${p.anomalies.join(", ")} · ` : ""}{p.stunType ? `STUN ${p.stunType} · ` : ""}{p.tlsSni ? `SNI ${p.tlsSni} · ` : ""}{p.dnsQuery ? `DNS ${p.dnsQuery} · ` : ""}{p.info}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </section>

                        <section className="vc-ipa-bottom-grid">
                            <div className="vc-ipa-panel">
                                <div className="vc-ipa-section-head">
                                    <div>
                                        <span className="vc-ipa-eyebrow">EVENT CORRELATION</span>
                                        <h2 className="vc-ipa-heading">Join / leave timeline</h2>
                                    </div>
                                </div>

                                <div className="vc-ipa-event-list">
                                    {voicePresenceEvents.length
                                        ? voicePresenceEvents.slice(0, 14).map((event, i) => (
                                            <div className={`vc-ipa-event vc-ipa-event-${event.type}`} key={`${event.time}-${event.userId ?? event.type}-${i}`}>
                                                <span className="vc-ipa-event-kind">
                                                    {event.type === "joined" ? "JOIN" : event.type === "left" ? "LEAVE" : "VOICE"}
                                                </span>
                                                <span>{new Date(event.time).toLocaleTimeString()}</span>
                                                <strong>{event.label}</strong>
                                                <span>{event.peerCount} peer{event.peerCount === 1 ? "" : "s"}</span>
                                            </div>
                                        ))
                                        : <div className="vc-ipa-empty">Join/leave activity will appear here.</div>}
                                </div>
                            </div>

                            <div className="vc-ipa-panel">
                                <div className="vc-ipa-section-head">
                                    <div>
                                        <span className="vc-ipa-eyebrow">CONNECTION HISTORY</span>
                                        <h2 className="vc-ipa-heading">Latency / loss</h2>
                                    </div>
                                </div>

                                <div className="vc-ipa-chart-block">
                                    <span>RTT</span>
                                    <Sparkline values={s.pingHistory} color="#5865f2" />
                                </div>
                                <div className="vc-ipa-chart-block">
                                    <span>Packet loss</span>
                                    <Sparkline values={s.lossHistory} color="#f23f43" />
                                </div>

                                <div className="vc-ipa-grid vc-ipa-grid-technical">
                                    <StatRow label="Packets in" value={s.packetsIn == null ? "-" : String(s.packetsIn)} />
                                    <StatRow label="Packets out" value={s.packetsOut == null ? "-" : String(s.packetsOut)} />
                                    <StatRow label="Packets lost" value={s.packetsLost == null ? "-" : String(s.packetsLost)} />
                                    <StatRow label="Quality" value={s.quality} />
                                    <StatRow label="Voice server" value={s.hostname} />
                                    <StatRow label="Payload" value={s.payloadInspection} />
                                </div>
                            </div>
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

async function refreshStats() {
    stats = await collectSelfStats();
    paint();
}

async function ensureUi() {
    if (!settings.store.showOverlay) {
        teardownUi();
        return;
    }
    if (mount && document.body.contains(mount)) {
        void refreshStats();
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

    void refreshStats();
    void fetchWiresharkSnapshot();

    pollHandle = setInterval(() => { void refreshStats(); }, 1000);
    wiresharkHandle = setInterval(() => { void fetchWiresharkSnapshot(); }, 1500);
}

function teardownUi(clearResize = true) {
    if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
    }
    if (wiresharkHandle) {
        clearInterval(wiresharkHandle);
        wiresharkHandle = null;
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
    description: "Connection and WebRTC overlay with optional localhost Wireshark/TShark packet capture, GeoIP of endpoints/RTC servers, and enrolled-device labels for this PC.",
    tags: ["Utility", "Appearance"],
    searchTerms: ["ipa", "packet", "packets", "pcap", "pcapng", "wireshark", "tshark", "tcp", "udp", "icmp", "webrtc", "dtls", "srtp", "ice", "codec", "ping", "rtt", "voice", "connection", "overlay", "jitter", "bitrate"],
    authors: [Delexo],
    settings,
    managedStyle,

    flux: {
        VOICE_STATE_UPDATES() {
            void refreshStats();
        },
        VOICE_CHANNEL_SELECT() {
            void refreshStats();
        },
        VOICE_CHANNEL_SELECT_V2() {
            void refreshStats();
        }
    },

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
