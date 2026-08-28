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
import { copyWithToast, openPrivateChannel, openUserProfile } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { RelationshipType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import {
    Button,
    ChannelStore,
    ContextMenuApi,
    createRoot,
    MediaEngineStore,
    Menu,
    ReactDOM,
    RelationshipStore,
    RTCConnectionStore,
    SelectedChannelStore,
    useLayoutEffect,
    useRef,
    useState,
    UserStore,
    VoiceStateStore
} from "@webpack/common";
import type { Root } from "react-dom/client";

import { parseEndpoint } from "./audit";
import { isPrivateIp } from "./sessionMatch";
import managedStyle from "./style.css?managed";

const Native = VencordNative.pluginHelpers["Internet Protocol Assessment"] as PluginNative<typeof import("./native")> | undefined;
const RelationshipActions = findByPropsLazy("addRelationship", "removeRelationship");

const ROOT_ID = "vc-ipa-root";
const UI_STORE_KEY = "IpaUiState";
const HISTORY_LEN = 48;
const MIN_OVERLAY_W = 280;
const MIN_OVERLAY_H = 200;
const DEFAULT_OVERLAY_W = 360;
const DEFAULT_OVERLAY_H = 300;
const LEGACY_DEFAULTS = [
    { width: 520, height: 560 },
    { width: 420, height: 400 }
] as const;
const OVERLAY_BAR_H = 36;
const MINIMIZED_OVERLAY_W = 252;
const OVERLAY_EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type OverlayEdge = typeof OVERLAY_EDGES[number];

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
    size: { width: number; height: number; };
};

let uiState: UiState = {
    minimized: false,
    maximized: false,
    pos: { left: 0, top: 0 },
    size: { width: DEFAULT_OVERLAY_W, height: DEFAULT_OVERLAY_H }
};

let mount: HTMLDivElement | null = null;
let root: Root | null = null;
let dragging = false;
let dragOffset = { x: 0, y: 0 };
let overlayResize: OverlayEdge | null = null;
let resizeStart = { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 };
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
    remoteCandidateType: string;
    localEndpoint: string;
    localCandidateType: string;
    localNetworkType: string;
    remoteNetworkType: string;
    bytesIn: number | null;
    bytesOut: number | null;
    pairRttMs: number | null;
    availableBitrateKbps: number | null;
    clientAdapter: string;
    clientEffectiveType: string;
    clientDownlink: string;
    clientRtt: string;
    audioCodecs: string[];
    payloadInspection: string;
    participants: ParticipantInfo[];
}

type ParticipantInfo = {
    id: string;
    name: string;
    avatar: string;
    self: boolean;
    connected: boolean;
    firstSeen: string;
    lastJoin: string;
    leftAt: string | null;
};

type GeoInfo = {
    ip: string;
    location: string;
    city: string | null;
    region: string | null;
    country: string | null;
    countryCode: string | null;
    latitude: number | null;
    longitude: number | null;
    isp: string | null;
    org: string | null;
    asn: string | null;
    asname?: string | null;
    mobile?: boolean | null;
    proxy?: boolean | null;
    hosting?: boolean | null;
    scope: string;
};


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
        isp?: string | null;
        org?: string | null;
        asn?: string | null;
        asname?: string | null;
        mobile?: boolean | null;
        proxy?: boolean | null;
        hosting?: boolean | null;
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
let sessionChannelId: string | null = null;
let lastSessionChannelName = "-";
const sessionRoster = new Map<string, ParticipantInfo>();
const ROSTER_LIMIT = 80;

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

function participantAvatar(userId: string, guildId?: string): string {
    try {
        const user = UserStore.getUser?.(userId) as {
            getAvatarURL?: (guild?: string, size?: number, canAnimate?: boolean) => string;
        } | undefined;
        return user?.getAvatarURL?.(guildId, 64, true)
            || user?.getAvatarURL?.(undefined, 64, true)
            || "";
    } catch {
        return "";
    }
}

function eventsForUser(userId: string): VoicePresenceEvent[] {
    return voicePresenceEvents.filter(event => event.userId === userId).slice(0, 8);
}

function formatClock(iso: string | null | undefined): string {
    if (!iso) return "-";
    try {
        return new Date(iso).toLocaleTimeString();
    } catch {
        return "-";
    }
}

function rosterParticipants(): ParticipantInfo[] {
    return [...sessionRoster.values()].sort((a, b) =>
        Number(b.self) - Number(a.self)
        || Number(b.connected) - Number(a.connected)
        || a.name.localeCompare(b.name)
    );
}

function trimRoster() {
    if (sessionRoster.size <= ROSTER_LIMIT) return;
    const extra = [...sessionRoster.values()]
        .filter(entry => !entry.connected && !entry.self)
        .sort((a, b) => String(a.leftAt || a.firstSeen).localeCompare(String(b.leftAt || b.firstSeen)));
    const removeCount = sessionRoster.size - ROSTER_LIMIT;
    for (const entry of extra.slice(0, Math.max(0, removeCount)))
        sessionRoster.delete(entry.id);
}

function syncSessionRoster(
    channelId: string | undefined,
    voiceStates: Record<string, unknown>,
    selfId: string | undefined,
    guildId?: string
) {
    const now = new Date().toISOString();
    const currentIds = Object.keys(voiceStates ?? {}).filter(Boolean);
    const normalized = channelId ?? null;

    if (normalized && normalized !== sessionChannelId) {
        sessionRoster.clear();
        sessionChannelId = normalized;
    }

    if (!normalized) {
        for (const entry of sessionRoster.values()) {
            if (entry.connected) {
                entry.connected = false;
                entry.leftAt = now;
            }
        }
        return;
    }

    for (const id of currentIds) {
        const existing = sessionRoster.get(id);
        if (existing) {
            existing.name = participantLabel(id);
            existing.avatar = participantAvatar(id, guildId) || existing.avatar;
            existing.self = id === selfId;
            if (!existing.connected) {
                existing.connected = true;
                existing.lastJoin = now;
                existing.leftAt = null;
            }
            continue;
        }
        sessionRoster.set(id, {
            id,
            name: participantLabel(id),
            avatar: participantAvatar(id, guildId),
            self: id === selfId,
            connected: true,
            firstSeen: now,
            lastJoin: now,
            leftAt: null
        });
    }

    for (const entry of sessionRoster.values()) {
        if (!currentIds.includes(entry.id) && entry.connected) {
            entry.connected = false;
            entry.leftAt = now;
        }
    }

    trimRoster();
}

function forgetRosterUser(userId: string) {
    sessionRoster.delete(userId);
    paint();
}

function addFriend(userId: string) {
    try {
        RelationshipActions.addRelationship({
            userId,
            context: { location: "ContextMenu" }
        });
    } catch { /* ignore */ }
}

function removeRelationship(userId: string) {
    try {
        RelationshipActions.removeRelationship(userId, { location: "ContextMenu" });
    } catch { /* ignore */ }
}

function blockUser(userId: string) {
    try {
        RelationshipActions.addRelationship({
            userId,
            context: { location: "ContextMenu" },
            type: RelationshipType.BLOCKED
        });
    } catch { /* ignore */ }
}

function relationshipItems(userId: string) {
    const rel = RelationshipStore.getRelationshipType?.(userId) ?? RelationshipType.NONE;
    switch (rel) {
        case RelationshipType.FRIEND:
            return (
                <Menu.MenuItem
                    id="vc-ipa-unfriend"
                    label="Remove Friend"
                    color="danger"
                    action={() => removeRelationship(userId)}
                />
            );
        case RelationshipType.BLOCKED:
            return (
                <Menu.MenuItem
                    id="vc-ipa-unblock"
                    label="Unblock"
                    action={() => removeRelationship(userId)}
                />
            );
        case RelationshipType.OUTGOING_REQUEST:
            return (
                <Menu.MenuItem
                    id="vc-ipa-cancel-friend"
                    label="Cancel Friend Request"
                    action={() => removeRelationship(userId)}
                />
            );
        case RelationshipType.INCOMING_REQUEST:
            return (
                <Menu.MenuItem
                    id="vc-ipa-accept-friend"
                    label="Accept Friend Request"
                    action={() => addFriend(userId)}
                />
            );
        case RelationshipType.NONE:
        case RelationshipType.IMPLICIT:
        case RelationshipType.SUGGESTION:
            return (
                <Menu.MenuItem
                    id="vc-ipa-add-friend"
                    label="Add Friend"
                    action={() => addFriend(userId)}
                />
            );
        default: {
            const _never: never = rel;
            return _never;
        }
    }
}

function openParticipantMenu(e: { preventDefault(): void; stopPropagation(): void; }, participant: ParticipantInfo) {
    e.preventDefault();
    e.stopPropagation();

    const selfId = UserStore.getCurrentUser?.()?.id;
    const isSelf = participant.id === selfId;

    ContextMenuApi.openContextMenu(e as any, () => (
        <Menu.Menu
            navId="vc-ipa-user-menu"
            onClose={ContextMenuApi.closeContextMenu}
            aria-label={`${participant.name} actions`}
        >
            <Menu.MenuGroup>
                <Menu.MenuItem
                    id="vc-ipa-profile"
                    label="Profile"
                    action={() => { void openUserProfile(participant.id); }}
                />
                {!isSelf && (
                    <Menu.MenuItem
                        id="vc-ipa-message"
                        label="Message"
                        action={() => openPrivateChannel(participant.id)}
                    />
                )}
            </Menu.MenuGroup>
            <Menu.MenuGroup>
                <Menu.MenuItem
                    id="vc-ipa-copy-name"
                    label="Copy Username"
                    action={() => { void copyWithToast(participant.name, "Username copied"); }}
                />
                <Menu.MenuItem
                    id="vc-ipa-copy-mention"
                    label="Copy Mention"
                    action={() => { void copyWithToast(`<@${participant.id}>`, "Mention copied"); }}
                />
                <Menu.MenuItem
                    id="vc-ipa-copy-id"
                    label="Copy User ID"
                    action={() => { void copyWithToast(participant.id, "User ID copied"); }}
                />
                <Menu.MenuItem
                    id="vc-ipa-copy-url"
                    label="Copy User URL"
                    action={() => { void copyWithToast(`https://discord.com/users/${participant.id}`, "User URL copied"); }}
                />
            </Menu.MenuGroup>
            {!isSelf && (
                <Menu.MenuGroup>
                    {relationshipItems(participant.id)}
                    {RelationshipStore.getRelationshipType?.(participant.id) !== RelationshipType.BLOCKED && (
                        <Menu.MenuItem
                            id="vc-ipa-block"
                            label="Block"
                            color="danger"
                            action={() => blockUser(participant.id)}
                        />
                    )}
                </Menu.MenuGroup>
            )}
            {!participant.connected && (
                <Menu.MenuGroup>
                    <Menu.MenuItem
                        id="vc-ipa-forget"
                        label="Remove from session log"
                        color="danger"
                        action={() => forgetRosterUser(participant.id)}
                    />
                </Menu.MenuGroup>
            )}
        </Menu.Menu>
    ));
}

function updateVoicePresenceEvents(
    channelId: string | undefined,
    voiceStates: Record<string, unknown>,
    selfId: string | undefined
) {
    const normalizedChannel = channelId ?? null;
    const currentIds = new Set(
        Object.keys(voiceStates ?? {}).filter(Boolean)
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
let lastStartAttempt = 0;
let deviceBStatus = "-";

function present(value: string | number | null | undefined, empty = "-"): string {
    if (value == null) return empty;
    const text = String(value).trim();
    return !text || text === "-" ? empty : text;
}

function geoFromRecord(
    geo: CapturedConnection["dstGeo"] | undefined,
    ip: string,
    location: string
): GeoInfo | null {
    if (!geo && !location) return null;
    const label = location
        || [geo?.city, geo?.region, geo?.countryCode || geo?.country].filter(Boolean).join(", ")
        || geo?.scope
        || "";
    if (!label) return null;
    return {
        ip,
        location: label,
        city: geo?.city ?? null,
        region: geo?.region ?? null,
        country: geo?.country ?? null,
        countryCode: geo?.countryCode ?? null,
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
        isp: geo?.isp ?? null,
        org: geo?.org ?? null,
        asn: geo?.asn ?? null,
        asname: geo?.asname ?? null,
        mobile: geo?.mobile ?? null,
        proxy: geo?.proxy ?? null,
        hosting: geo?.hosting ?? null,
        scope: geo?.scope || "Public"
    };
}

function ingestFlowGeo(conn: CapturedConnection) {
    const geo = geoFromRecord(conn.dstGeo, conn.dst, conn.dstLocation);
    if (!geo || !conn.dst) return;
    const key = conn.dst.toLowerCase();
    const existing = geoByKey.get(key);
    if (!existing || (existing.latitude == null && geo.latitude != null))
        geoByKey.set(key, geo);
}

async function ensureGeo(raw: string) {
    const key = String(raw || "").trim();
    if (!key || key === "-" || isPrivateIp(key)) return;
    const lookup = key.toLowerCase();
    if (geoByKey.has(lookup) || geoInFlight.has(lookup)) return;
    const helper = native();
    if (!helper?.lookupGeo) return;
    geoInFlight.add(lookup);
    try {
        const res = await helper.lookupGeo(key) as (GeoInfo & { ok?: boolean; }) | undefined;
        if (!res?.ok) return;
        geoByKey.set(lookup, {
            ip: present(res.ip, key),
            location: present(res.location, "Unknown"),
            city: res.city ?? null,
            region: res.region ?? null,
            country: res.country ?? null,
            countryCode: res.countryCode ?? null,
            latitude: res.latitude ?? null,
            longitude: res.longitude ?? null,
            isp: res.isp ?? null,
            org: res.org ?? null,
            asn: res.asn ?? null,
            asname: res.asname ?? null,
            mobile: res.mobile ?? null,
            proxy: res.proxy ?? null,
            hosting: res.hosting ?? null,
            scope: res.scope || "Public"
        });
        paint();
    } finally {
        geoInFlight.delete(lookup);
    }
}

function applySnapshot(next: WiresharkSnapshot) {
    wiresharkSnapshot = {
        ...EMPTY_WIRESHARK,
        ...next,
        connections: Array.isArray(next.connections) ? next.connections.slice(0, 40) : [],
        recentPackets: Array.isArray(next.recentPackets) ? next.recentPackets.slice(-120) : []
    };
    for (const conn of wiresharkSnapshot.connections)
        ingestFlowGeo(conn);
}

function overlaySubtitle(s: SelfStats): string {
    if (captureBusy) return inVoiceNow() ? "Starting capture..." : "Stopping capture...";
    if (lastCaptureMessage && !wiresharkSnapshot.running) return lastCaptureMessage;
    if (wiresharkSnapshot.running) {
        const pps = Number(wiresharkSnapshot.packetsPerSecond ?? 0).toFixed(1);
        return `Live capture · ${pps} pkt/s · ${wiresharkSnapshot.interfaceName}`;
    }
    if (s.reconnecting) return "Reconnecting...";
    if (s.connected || inVoiceNow()) return "Joining voice · capture starts automatically";
    return "Join a voice channel to start capture";
}

function inVoiceNow(): boolean {
    try {
        return Boolean(
            SelectedChannelStore.getVoiceChannelId?.() ??
            RTCConnectionStore.getChannelId?.() ??
            RTCConnectionStore.isConnected?.()
        );
    } catch {
        return false;
    }
}

async function syncVoiceCapture() {
    const inVoice = inVoiceNow();
    if (inVoice) {
        if (wiresharkSnapshot.running || captureBusy) return;
        const now = Date.now();
        if (now - lastStartAttempt < 2500) return;
        lastStartAttempt = now;
        await startLocalCapture();
        return;
    }
    lastStartAttempt = 0;
    if (!wiresharkSnapshot.running && !captureBusy) return;
    await stopLocalCapture();
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
    remoteCandidateType: "-",
    localEndpoint: "-",
    localCandidateType: "-",
    localNetworkType: "-",
    remoteNetworkType: "-",
    bytesIn: null,
    bytesOut: null,
    pairRttMs: null,
    availableBitrateKbps: null,
    clientAdapter: "-",
    clientEffectiveType: "-",
    clientDownlink: "-",
    clientRtt: "-",
    audioCodecs: [],
    payloadInspection: "Not performed",
    participants: []
};

const geoByKey = new Map<string, GeoInfo>();
const geoInFlight = new Set<string>();

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
    if (saved.size && typeof saved.size.width === "number" && typeof saved.size.height === "number") {
        const isLegacyDefault = LEGACY_DEFAULTS.some(
            size => size.width === saved.size.width && size.height === saved.size.height
        );
        uiState.size = isLegacyDefault
            ? { width: DEFAULT_OVERLAY_W, height: DEFAULT_OVERLAY_H }
            : clampSize(saved.size.width, saved.size.height);
        if (isLegacyDefault) scheduleUiSave();
    }
}

type TransportStats = {
    transportProtocol: string;
    dtlsState: string;
    dtlsCipher: string;
    srtpCipher: string;
    selectedCandidateState: string;
    localCandidateProtocol: string;
    remoteCandidateProtocol: string;
    remoteEndpoint: string;
    remoteCandidateType: string;
    localEndpoint: string;
    localCandidateType: string;
    localNetworkType: string;
    remoteNetworkType: string;
    bytesIn: number | null;
    bytesOut: number | null;
    pairRttMs: number | null;
    availableBitrateKbps: number | null;
    audioCodecs: string[];
    packetsIn: number | null;
    packetsOut: number | null;
    packetsLost: number | null;
    jitterMs: number | null;
    bitrateKbps: number | null;
};

function emptyTransportStats(): TransportStats {
    return {
        transportProtocol: "-",
        dtlsState: "-",
        dtlsCipher: "-",
        srtpCipher: "-",
        selectedCandidateState: "-",
        localCandidateProtocol: "-",
        remoteCandidateProtocol: "-",
        remoteEndpoint: "-",
        remoteCandidateType: "-",
        localEndpoint: "-",
        localCandidateType: "-",
        localNetworkType: "-",
        remoteNetworkType: "-",
        bytesIn: null,
        bytesOut: null,
        pairRttMs: null,
        availableBitrateKbps: null,
        audioCodecs: [],
        packetsIn: null,
        packetsOut: null,
        packetsLost: null,
        jitterMs: null,
        bitrateKbps: null
    };
}

function asStatList(value: unknown): any[] {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") return Object.values(value as object);
    return [];
}

function firstFinite(rows: any[], keys: string[]): number | null {
    for (const row of rows) {
        for (const key of keys) {
            const n = numOrNull(row?.[key]);
            if (n != null) return n;
        }
    }
    return null;
}

function sumFields(rows: any[], keys: string[]): number | null {
    let total = 0;
    let any = false;
    for (const row of rows) {
        for (const key of keys) {
            const n = numOrNull(row?.[key]);
            if (n != null) {
                total += n;
                any = true;
                break;
            }
        }
    }
    return any ? total : null;
}

function codecNames(rows: any[]): string[] {
    return [...new Set(
        rows
            .flatMap(row => [
                row?.codecName,
                row?.codec?.name,
                row?.codec?.mimeType,
                typeof row?.codec === "string" ? row.codec : "",
                row?.mimeType
            ])
            .map(v => String(v || "").trim())
            .filter(v => v && v !== "-")
    )];
}

function endpointOf(address: unknown, port: unknown): string {
    const host = String(address || "").trim();
    if (!host) return "-";
    const p = numOrNull(port);
    return p != null ? `${host}:${p}` : host;
}

function isRtcStatsReport(raw: any): boolean {
    return !!raw && typeof raw.values === "function";
}

function audioRows(rows: any[]): any[] {
    const audio = rows.filter(row => {
        const kind = String(row?.kind ?? row?.mediaType ?? row?.type ?? "").toLowerCase();
        return !kind || kind === "audio" || kind.includes("audio");
    });
    return audio.length ? audio : rows;
}

function jitterToMs(value: number | null): number | null {
    if (value == null) return null;
    return value < 8 ? value * 1000 : value;
}

function kbps(value: number | null): number | null {
    if (value == null) return null;
    return value > 1000 ? value / 1000 : value;
}

function mergeTransport(base: TransportStats, patch: Partial<TransportStats>): TransportStats {
    const next = { ...base };
    (Object.keys(patch) as (keyof TransportStats)[]).forEach(key => {
        const value = patch[key];
        if (value == null || value === "-") return;
        if (Array.isArray(value) && value.length === 0) return;
        (next as any)[key] = value;
    });
    return next;
}

function pickVoiceConnection(rtc: any): any {
    const found: any[] = [];
    const push = (value: any) => {
        if (value && !found.includes(value)) found.push(value);
    };
    push(rtc);
    push(rtc?.connection);
    push(rtc?._connection);
    push(rtc?.mediaEngineConnection);
    push(rtc?.pc);
    push(rtc?._pc);
    push(rtc?.peerConnection);
    try {
        const engine = (MediaEngineStore as any).getMediaEngine?.();
        const conns = engine?.connections;
        if (conns && typeof conns[Symbol.iterator] === "function") {
            const def: any[] = [];
            const other: any[] = [];
            for (const conn of conns) {
                if (conn?.destroyed) continue;
                if (conn.context === "default" || conn.context == null) def.push(conn);
                else other.push(conn);
            }
            for (const conn of def.concat(other)) push(conn);
        }
    } catch { /* ignore */ }
    return found.find(conn =>
        typeof conn?.getStats === "function" && typeof conn?.getConnectionTransportOptions === "function"
    )
        ?? found.find(conn => typeof conn?.getStats === "function")
        ?? found.find(conn => typeof conn?.getConnectionTransportOptions === "function")
        ?? found[0]
        ?? null;
}

function parseWebRtcRows(stats: any[], conn: any): Partial<TransportStats> {
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
    const fallbackRemote = stats.find(s => s.type === "remote-candidate" && (s.address || s.ip));
    const codecMap = new Map(
        stats
            .filter(s => s.type === "codec" && typeof s.mimeType === "string")
            .map(s => [s.id, s])
    );
    const inbound = stats.filter(s =>
        s.type === "inbound-rtp" && String(s.kind ?? s.mediaType ?? "").toLowerCase() === "audio"
    );
    const outbound = stats.filter(s =>
        s.type === "outbound-rtp" && String(s.kind ?? s.mediaType ?? "").toLowerCase() === "audio"
    );
    const pairRtt = numOrNull(candidatePair?.currentRoundTripTime);
    return {
        transportProtocol: String(
            localCandidate?.protocol ?? remoteCandidate?.protocol ?? candidatePair?.protocol ?? "-"
        ).toUpperCase(),
        dtlsState: String(transport?.dtlsState ?? conn?.sctp?.transport?.state ?? "-"),
        dtlsCipher: String(transport?.dtlsCipher ?? "-"),
        srtpCipher: String(transport?.srtpCipher ?? "-"),
        selectedCandidateState: String(candidatePair?.state ?? "-"),
        localCandidateProtocol: String(localCandidate?.protocol ?? "-").toUpperCase(),
        remoteCandidateProtocol: String(remoteCandidate?.protocol ?? "-").toUpperCase(),
        remoteEndpoint: endpointOf(
            remoteCandidate?.address ?? remoteCandidate?.ip ?? fallbackRemote?.address ?? fallbackRemote?.ip,
            remoteCandidate?.port ?? fallbackRemote?.port
        ),
        remoteCandidateType: String(
            remoteCandidate?.candidateType
            ?? remoteCandidate?.type
            ?? fallbackRemote?.candidateType
            ?? fallbackRemote?.type
            ?? "-"
        ),
        localEndpoint: endpointOf(localCandidate?.address ?? localCandidate?.ip, localCandidate?.port),
        localCandidateType: String(localCandidate?.candidateType ?? localCandidate?.type ?? "-"),
        localNetworkType: String(localCandidate?.networkType ?? localCandidate?.adapterType ?? "-"),
        remoteNetworkType: String(remoteCandidate?.networkType ?? fallbackRemote?.networkType ?? "-"),
        bytesIn: numOrNull(candidatePair?.bytesReceived) ?? sumFields(inbound, ["bytesReceived"]),
        bytesOut: numOrNull(candidatePair?.bytesSent) ?? sumFields(outbound, ["bytesSent"]),
        pairRttMs: pairRtt != null ? pairRtt * (pairRtt < 10 ? 1000 : 1) : null,
        availableBitrateKbps: kbps(numOrNull(candidatePair?.availableOutgoingBitrate)),
        audioCodecs: [...new Set(
            inbound.concat(outbound)
                .map(s => codecMap.get(s.codecId)?.mimeType)
                .filter((v): v is string => typeof v === "string")
        )],
        packetsIn: inbound.length ? inbound.reduce((n, s) => n + (Number(s.packetsReceived) || 0), 0) : null,
        packetsOut: outbound.length ? outbound.reduce((n, s) => n + (Number(s.packetsSent) || 0), 0) : null,
        packetsLost: inbound.length ? inbound.reduce((n, s) => n + (Number(s.packetsLost) || 0), 0) : null,
        jitterMs: jitterToMs(firstFinite(inbound, ["jitterBufferDelay", "jitter"])),
        bitrateKbps: kbps(firstFinite(outbound, ["bitrate", "targetBitrate"]))
    };
}

function parseNativeVoiceStats(raw: any): Partial<TransportStats> {
    if (!raw || typeof raw !== "object") return {};
    const rtp = raw.rtp ?? raw.RTP ?? raw.media ?? {};
    const inbound = audioRows(asStatList(rtp.inbound ?? rtp.Inbound ?? raw.inbound));
    const outbound = audioRows(asStatList(rtp.outbound ?? rtp.Outbound ?? raw.outbound));
    const transport = raw.transport ?? raw.Transport ?? {};
    return {
        transportProtocol: String(transport.protocol || transport.type || "UDP").toUpperCase(),
        dtlsState: String(transport.dtlsState ?? raw.dtlsState ?? "-"),
        dtlsCipher: String(transport.dtlsCipher ?? raw.dtlsCipher ?? "-"),
        srtpCipher: String(transport.srtpCipher ?? transport.encryptionMode ?? raw.encryptionMode ?? "-"),
        selectedCandidateState: String(transport.state ?? "-"),
        localCandidateProtocol: String(transport.localProtocol ?? "UDP").toUpperCase(),
        remoteCandidateProtocol: String(transport.remoteProtocol ?? "UDP").toUpperCase(),
        remoteEndpoint: endpointOf(
            transport.remoteAddress ?? transport.receiverAddress ?? raw.remoteAddress,
            transport.remotePort ?? raw.remotePort
        ),
        remoteCandidateType: String(transport.remoteCandidateType ?? transport.iceType ?? "-"),
        localEndpoint: endpointOf(
            transport.localAddress ?? transport.senderAddress ?? raw.localAddress,
            transport.localPort ?? raw.localPort
        ),
        localCandidateType: String(transport.localCandidateType ?? "-"),
        localNetworkType: String(transport.networkType ?? transport.localNetworkType ?? "-"),
        remoteNetworkType: String(transport.remoteNetworkType ?? "-"),
        bytesIn: sumFields(inbound, ["bytesReceived", "bytes", "recvBytes"]) ?? numOrNull(transport.bytesReceived),
        bytesOut: sumFields(outbound, ["bytesSent", "bytes", "sentBytes"]) ?? numOrNull(transport.bytesSent),
        pairRttMs: numOrNull(transport.ping) ?? numOrNull(transport.rtt) ?? numOrNull(raw.ping),
        availableBitrateKbps: kbps(
            numOrNull(transport.availableOutgoingBitrate) ?? numOrNull(transport.sendBitrate)
        ),
        audioCodecs: codecNames(inbound.concat(outbound)),
        packetsIn: sumFields(inbound, ["packetsReceived", "packets", "recvPackets"]),
        packetsOut: sumFields(outbound, ["packetsSent", "packets", "sentPackets"]),
        packetsLost: sumFields(inbound, ["packetsLost", "lost"]),
        jitterMs: jitterToMs(firstFinite(inbound, ["jitterBufferMs", "jitterMs", "jitter"])),
        bitrateKbps: kbps(
            firstFinite(outbound, ["bitrate", "audioBitrate", "bytesSentPerSecond"])
            ?? numOrNull(transport.bitrate)
        )
    };
}

function connectionHints(conn: any, connected: boolean, hostname: string): Partial<TransportStats> {
    const opts = typeof conn?.getConnectionTransportOptions === "function"
        ? conn.getConnectionTransportOptions()
        : null;
    const patch: Partial<TransportStats> = {};
    if (opts?.address)
        patch.remoteEndpoint = endpointOf(opts.address, opts.port);
    if (Array.isArray(opts?.modes) && opts.modes[0])
        patch.srtpCipher = String(opts.modes[0]);
    if (opts?.audioCodec?.name)
        patch.audioCodecs = [String(opts.audioCodec.name)];
    if (typeof conn?.voiceBitrate === "number")
        patch.bitrateKbps = kbps(conn.voiceBitrate);
    if (connected) {
        patch.dtlsState = "connected";
        patch.transportProtocol = "UDP";
        patch.selectedCandidateState = "succeeded";
        patch.localCandidateProtocol = "UDP";
        patch.remoteCandidateProtocol = "UDP";
    }
    if (/discord\.media/i.test(hostname))
        patch.remoteCandidateType = "relay";
    return patch;
}

/**
 * Live transport stats from Discord's voice connection.
 * Uses MediaEngine getStats / WebRTC getStats only — no payload inspection.
 */
async function collectTransportSecurityStats(
    conn: any,
    connected = false,
    hostname = ""
): Promise<TransportStats> {
    let out = mergeTransport(emptyTransportStats(), connectionHints(conn, connected, hostname));
    if (!conn || typeof conn.getStats !== "function") return out;
    try {
        const report = await conn.getStats();
        const parsed = isRtcStatsReport(report)
            ? parseWebRtcRows([...report.values()], conn)
            : parseNativeVoiceStats(report);
        return mergeTransport(out, parsed);
    } catch {
        return out;
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

        const selfId = UserStore.getCurrentUser?.()?.id;

        if (!channelId && !connected && !reconnecting) {
            pingHistory = [];
            lossHistory = [];
            updateVoicePresenceEvents(undefined, {}, selfId);
            syncSessionRoster(undefined, {}, selfId);
            const leftover = rosterParticipants();
            if (!leftover.length) return EMPTY_STATS;
            return {
                ...EMPTY_STATS,
                ...readClientNetwork(),
                channelName: lastSessionChannelName,
                participants: leftover
            };
        }

        const channel = channelId ? ChannelStore.getChannel(channelId) : null;
        const voiceStates = channelId
            ? (VoiceStateStore.getVoiceStatesForChannel?.(channelId) ?? {})
            : {};
        const peerCount = Math.max(0, Object.keys(voiceStates).length - 1);

        const mes = MediaEngineStore as any;
        updateVoicePresenceEvents(channelId, voiceStates, selfId);

        const guildId = channel?.guild_id;
        if (channel?.name) lastSessionChannelName = channel.name;
        else if (channelId) lastSessionChannelName = "Voice channel";
        syncSessionRoster(channelId, voiceStates, selfId, guildId);
        const participants = rosterParticipants();

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

        const rtc = RTCConnectionStore.getRTCConnection?.() as any;
        const voiceConn = pickVoiceConnection(rtc);
        const transportStats = await collectTransportSecurityStats(voiceConn, connected, hostname);
        const clientNet = readClientNetwork();

        const jitterMs =
            transportStats.jitterMs ??
            numOrNull(voiceConn?.jitter) ??
            numOrNull(voiceConn?.jitterBufferMs) ??
            numOrNull(rtc?.jitter) ??
            numOrNull(rtc?.stats?.jitter) ??
            null;

        let bitrateKbps =
            transportStats.bitrateKbps ??
            numOrNull(voiceConn?.voiceBitrate) ??
            numOrNull(rtc?.bitrate) ??
            numOrNull(rtc?.audioBitrate) ??
            numOrNull(rtc?.outboundBitrate) ??
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
            remoteCandidateType: transportStats.remoteCandidateType,
            localEndpoint: transportStats.localEndpoint,
            localCandidateType: transportStats.localCandidateType,
            localNetworkType: transportStats.localNetworkType,
            remoteNetworkType: transportStats.remoteNetworkType,
            bytesIn: transportStats.bytesIn,
            bytesOut: transportStats.bytesOut,
            pairRttMs: transportStats.pairRttMs,
            availableBitrateKbps: transportStats.availableBitrateKbps,
            clientAdapter: clientNet.clientAdapter !== "Unknown"
                ? clientNet.clientAdapter
                : nicLabel(transportStats.localNetworkType),
            clientEffectiveType: clientNet.clientEffectiveType,
            clientDownlink: clientNet.clientDownlink,
            clientRtt: clientNet.clientRtt,
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

function nicLabel(raw: string): string {
    const v = String(raw || "").toLowerCase();
    switch (v) {
        case "wifi":
        case "wlan":
        case "802.11":
            return "Wi-Fi";
        case "ethernet":
        case "wired":
        case "lan":
            return "Ethernet";
        case "cellular":
        case "cell":
        case "wwan":
        case "mobile":
            return "Cellular";
        case "bluetooth":
            return "Bluetooth";
        case "vpn":
            return "VPN";
        case "wimax":
            return "WiMAX";
        case "mixed":
            return "Mixed";
        case "other":
            return "Other";
        case "unknown":
        case "":
        case "-":
            return "Unknown";
        default:
            return raw;
    }
}

function readClientNetwork() {
    const nav = navigator as Navigator & { connection?: any; mozConnection?: any; webkitConnection?: any; };
    const c = nav.connection || nav.mozConnection || nav.webkitConnection;
    const effective = String(c?.effectiveType || "").toLowerCase();
    let effectiveLabel = "-";
    switch (effective) {
        case "4g":
            effectiveLabel = "4G";
            break;
        case "3g":
            effectiveLabel = "3G";
            break;
        case "2g":
            effectiveLabel = "2G";
            break;
        case "slow-2g":
            effectiveLabel = "Slow 2G";
            break;
        case "":
            effectiveLabel = "-";
            break;
        default:
            effectiveLabel = String(c?.effectiveType || "-");
            break;
    }
    return {
        clientAdapter: nicLabel(c?.type || ""),
        clientEffectiveType: effectiveLabel,
        clientDownlink: typeof c?.downlink === "number" ? `${c.downlink} Mb/s` : "-",
        clientRtt: typeof c?.rtt === "number" ? `${c.rtt} ms` : "-"
    };
}

function pathKind(ice: string, hosting: boolean | null | undefined, ip: string): string {
    if (ip && isPrivateIp(ip)) return "Private / LAN path";
    const t = String(ice || "").toLowerCase();
    switch (t) {
        case "relay":
            return "Discord relay / TURN (shared RTC infra)";
        case "srflx":
            return hosting ? "Server-reflexive via hosting/CDN" : "Server-reflexive public path";
        case "prflx":
            return "Peer-reflexive public path";
        case "host":
            return "Host candidate (LAN or local NIC)";
        default:
            return hosting ? "Datacenter / hosting IP" : "Observed public endpoint";
    }
}

function clampPos(left: number, top: number, w: number, h: number) {
    const maxL = Math.max(8, window.innerWidth - w - 8);
    const maxT = Math.max(8, window.innerHeight - h - 8);
    return {
        left: Math.min(Math.max(8, left), maxL),
        top: Math.min(Math.max(8, top), maxT)
    };
}

function clampSize(width: number, height: number) {
    return {
        width: Math.min(Math.max(MIN_OVERLAY_W, width), Math.max(MIN_OVERLAY_W, window.innerWidth - 16)),
        height: Math.min(Math.max(MIN_OVERLAY_H, height), Math.max(MIN_OVERLAY_H, window.innerHeight - 16))
    };
}

function defaultPos(w: number, h: number) {
    return clampPos(window.innerWidth - w - 18, window.innerHeight - h - 88, w, h);
}

function overlayBoxStyle(ui: UiState) {
    if (ui.maximized) {
        return {
            left: 12,
            top: 12,
            width: Math.max(MIN_OVERLAY_W, window.innerWidth - 24),
            height: Math.max(MIN_OVERLAY_H, window.innerHeight - 24)
        };
    }
    if (ui.minimized) {
        return {
            left: ui.pos.left,
            top: ui.pos.top,
            width: MINIMIZED_OVERLAY_W,
            height: OVERLAY_BAR_H
        };
    }
    return {
        left: ui.pos.left,
        top: ui.pos.top,
        width: ui.size.width,
        height: ui.size.height
    };
}

function applyOverlayResize(clientX: number, clientY: number) {
    if (!overlayResize) return;
    const dx = clientX - resizeStart.x;
    const dy = clientY - resizeStart.y;
    let width = resizeStart.width;
    let height = resizeStart.height;
    let left = resizeStart.left;
    let top = resizeStart.top;

    if (overlayResize.includes("e")) width = resizeStart.width + dx;
    if (overlayResize.includes("s")) height = resizeStart.height + dy;
    if (overlayResize.includes("w")) width = resizeStart.width - dx;
    if (overlayResize.includes("n")) height = resizeStart.height - dy;

    const next = clampSize(width, height);
    width = next.width;
    height = next.height;

    if (overlayResize.includes("w"))
        left = resizeStart.left + resizeStart.width - width;
    if (overlayResize.includes("n"))
        top = resizeStart.top + resizeStart.height - height;

    uiState.size = { width, height };
    uiState.pos = clampPos(left, top, width, height);
}

function startOverlayResize(edge: OverlayEdge, e: { clientX: number; clientY: number; pointerId: number; preventDefault(): void; stopPropagation(): void; currentTarget: HTMLElement; }) {
    if (uiState.maximized || uiState.minimized) return;
    e.preventDefault();
    e.stopPropagation();
    overlayResize = edge;
    resizeStart = {
        x: e.clientX,
        y: e.clientY,
        left: uiState.pos.left,
        top: uiState.pos.top,
        width: uiState.size.width,
        height: uiState.size.height
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    paint();
}

function moveOverlayResize(e: { clientX: number; clientY: number; }) {
    if (!overlayResize) return;
    applyOverlayResize(e.clientX, e.clientY);
    paint();
}

function endOverlayResize() {
    if (!overlayResize) return;
    overlayResize = null;
    scheduleUiSave();
    paint();
}

function onResize() {
    if (uiState.maximized) {
        paint();
        return;
    }
    uiState.size = clampSize(uiState.size.width, uiState.size.height);
    uiState.pos = clampPos(uiState.pos.left, uiState.pos.top, uiState.size.width, uiState.size.height);
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

function getPrimaryVoiceFlow(remoteIp?: string): CapturedConnection | null {
    const flows = [...(wiresharkSnapshot.connections ?? [])];
    if (remoteIp) {
        const matched = flows.filter(c => c.dst === remoteIp || c.src === remoteIp);
        if (matched.length)
            return matched.sort((a, b) => scoreVoiceFlow(b) - scoreVoiceFlow(a))[0] ?? null;
    }
    return flows.sort((a, b) => scoreVoiceFlow(b) - scoreVoiceFlow(a))[0] ?? null;
}

type ObservedDest = {
    ip: string;
    port: number | null;
    endpoint: string;
    hostname: string;
    flow: CapturedConnection | null;
    geo: GeoInfo | null;
    location: string;
    isp: string;
    candidateType: string;
    transport: string;
    packets: string;
    security: string;
    authorized: string;
    delta: string;
    ttl: string;
    regionalArea: string;
    pathKind: string;
    carrier: string;
    org: string;
    asn: string;
    coords: string;
    flags: string;
};

function iceLabel(type: string): string {
    switch (String(type || "").toLowerCase()) {
        case "relay":
            return "Relay / TURN";
        case "srflx":
            return "Server reflexive";
        case "prflx":
            return "Peer reflexive";
        case "host":
            return "Host / LAN";
        case "":
        case "-":
            return "Unknown";
        default:
            return type;
    }
}

function getObservedDest(s: SelfStats): ObservedDest {
    const parsed = parseEndpoint(s.remoteEndpoint);
    const flow = getPrimaryVoiceFlow(parsed?.ip);
    const stunIp = String(flow?.stunXorMappedAddress || "").trim();
    const publicIp =
        (parsed?.ip && !isPrivateIp(parsed.ip) ? parsed.ip : "")
        || (flow && !isPrivateIp(flow.dst) ? flow.dst : "")
        || (stunIp && !isPrivateIp(stunIp) ? stunIp : "");
    const ip = publicIp || parsed?.ip || flow?.dst || "";
    const port = parsed?.port ?? flow?.dport ?? flow?.stunXorMappedPort ?? null;
    const endpoint = ip
        ? `${ip}${port != null ? `:${port}` : ""}`
        : present(s.remoteEndpoint, s.hostname !== "-" ? s.hostname : "No active endpoint");

    const geo =
        (ip ? geoByKey.get(ip.toLowerCase()) : undefined)
        || (s.hostname !== "-" ? geoByKey.get(s.hostname.toLowerCase()) : undefined)
        || geoFromRecord(flow?.dstGeo, ip, flow?.dstLocation || "")
        || null;

    const location = present(
        geo?.location
        || flow?.dstLocation
        || (ip && isPrivateIp(ip) ? "Private/LAN" : "")
        || (s.hostname !== "-" ? s.hostname : ""),
        "Unknown"
    );
    const isp = present(geo?.isp || geo?.org || geo?.asn, "Unknown");
    const transport = [...new Set(
        [s.transportProtocol, s.remoteCandidateProtocol, flow?.transport, flow?.protocol]
            .map(v => present(v, ""))
            .filter(Boolean)
    )].join(" / ") || "Unknown";
    const packets = (s.packetsIn != null || s.packetsOut != null)
        ? s.packetsOut != null
            ? `${s.packetsIn ?? 0} in · ${s.packetsOut} out`
            : String(s.packetsIn ?? 0)
        : flow?.packets
            ? String(flow.packets)
            : "-";
    const encrypted = s.dtlsState.toLowerCase() === "connected"
        || flow?.encrypted === "Encrypted transport"
        || (s.srtpCipher !== "-" && s.srtpCipher !== "");
    const security = [
        encrypted ? "Encrypted transport" : "",
        s.dtlsState !== "-" ? `DTLS ${s.dtlsState}` : "",
        s.dtlsCipher !== "-" ? s.dtlsCipher : "",
        s.srtpCipher !== "-" ? s.srtpCipher : "",
        flow?.encrypted && flow.encrypted !== "Unknown" && flow.encrypted !== "Encrypted transport" ? flow.encrypted : ""
    ].filter(Boolean).join(" · ") || "Unknown";
    const regionalArea = location === "Unknown" || location === "Private/LAN" || (ip && isPrivateIp(ip))
        ? location
        : `${location} (RTC infra)`;
    const flags = [
        geo?.mobile ? "Mobile ISP" : "",
        geo?.proxy ? "Proxy/VPN" : "",
        geo?.hosting ? "Hosting/datacenter" : ""
    ].filter(Boolean).join(" · ") || "None flagged";
    const coords = geo?.latitude != null && geo?.longitude != null
        ? `${geo.latitude.toFixed(4)}, ${geo.longitude.toFixed(4)}`
        : "-";

    return {
        ip,
        port,
        endpoint,
        hostname: s.hostname,
        flow,
        geo,
        location,
        isp,
        candidateType: iceLabel(s.remoteCandidateType),
        transport,
        packets,
        security,
        authorized: flow?.dstAuthorizedLabel || flow?.srcAuthorizedLabel || "Not enrolled",
        delta: flow?.lastDeltaMs != null ? `${flow.lastDeltaMs.toFixed(3)} ms` : "-",
        ttl: flow?.ttl != null || flow?.hopLimit != null ? String(flow?.ttl ?? flow?.hopLimit) : "-",
        regionalArea,
        pathKind: pathKind(s.remoteCandidateType, geo?.hosting, ip),
        carrier: present(geo?.isp || geo?.org || geo?.asname, "Unknown"),
        org: present(geo?.org, "Unknown"),
        asn: present(geo?.asname || geo?.asn, "Unknown"),
        coords,
        flags
    };
}

function destLookupKeys(s: SelfStats, dest: ObservedDest): string[] {
    const keys: string[] = [];
    if (dest.ip && !isPrivateIp(dest.ip)) keys.push(dest.ip);
    if (s.hostname && s.hostname !== "-") keys.push(s.hostname);
    return [...new Set(keys)];
}

function liveUserMedia(userId: string, self: boolean, s: SelfStats) {
    if (self) {
        return {
            speaking: s.speaking,
            video: s.video,
            streaming: s.streaming,
            muted: s.muted,
            deafened: s.deafened
        };
    }
    const vs = VoiceStateStore.getVoiceStateForUser?.(userId) as {
        selfVideo?: boolean;
        selfStream?: boolean;
        selfMute?: boolean;
        mute?: boolean;
        selfDeaf?: boolean;
        deaf?: boolean;
    } | undefined;
    let speaking = false;
    try {
        speaking = !!(MediaEngineStore as any).isSpeaking?.(userId);
    } catch { /* ignore */ }
    return {
        speaking,
        video: !!vs?.selfVideo,
        streaming: !!vs?.selfStream,
        muted: !!(vs?.selfMute || vs?.mute),
        deafened: !!(vs?.selfDeaf || vs?.deaf)
    };
}

function sessionStatusLabel(s: SelfStats, participant: ParticipantInfo): string {
    if (!participant.connected) return "DISCONNECTED";
    if (s.reconnecting) return "RECONNECTING";
    if (s.connected) return "CONNECTED";
    return present(s.state, "UNKNOWN").replace(/^RTC_/, "");
}

function TipRow({ label, value, code }: { label: string; value: string; code?: boolean; }) {
    const empty = !value || value === "-";
    const cls = empty ? "vc-ipa-bone" : "";
    return (
        <>
            <span>{label}</span>
            {code ? <code className={cls}>{value}</code> : <strong className={cls}>{value}</strong>}
        </>
    );
}

function TipSection({ title, children }: { title: string; children: any; }) {
    return (
        <div className="vc-ipa-tooltip-section">
            <em>{title}</em>
            <div className="vc-ipa-tooltip-grid">{children}</div>
        </div>
    );
}

function DestinationMap({ dest, compact }: { dest: ObservedDest; compact?: boolean; }) {
    const q = dest.geo?.latitude != null && dest.geo?.longitude != null
        ? `${dest.geo.latitude},${dest.geo.longitude}`
        : dest.location && dest.location !== "Unknown" && dest.location !== "Private/LAN"
            ? dest.location
            : dest.hostname !== "-"
                ? dest.hostname
                : "";
    if (!q) {
        return <div className="vc-ipa-map vc-ipa-map-empty">Waiting for destination coordinates.</div>;
    }
    const embed = `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=6&output=embed`;
    const openQuery = dest.geo?.latitude != null && dest.geo?.longitude != null
        ? `${dest.geo.latitude},${dest.geo.longitude}`
        : q;
    return (
        <div className={"vc-ipa-map" + (compact ? " is-compact" : "")}>
            <iframe
                className="vc-ipa-map-frame"
                src={embed}
                title="Destination map"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
            />
            <button
                type="button"
                className="vc-ipa-map-open"
                onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    void native()?.openMap(openQuery);
                }}
            >
                Open Google Maps
            </button>
        </div>
    );
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

function eventKind(type: VoicePresenceEvent["type"]): string {
    switch (type) {
        case "joined":
            return "JOIN";
        case "left":
            return "LEAVE";
        case "channel":
            return "VOICE";
        default: {
            const _never: never = type;
            return _never;
        }
    }
}

function UserAvatar({ src, name }: { src: string; name: string; }) {
    if (src) {
        return <img className="vc-ipa-avatar" src={src} alt="" />;
    }
    return (
        <span className="vc-ipa-avatar vc-ipa-avatar-fallback" aria-hidden="true">
            {(name.trim()[0] || "?").toUpperCase()}
        </span>
    );
}

function placeTooltip(anchor: DOMRect, tip: HTMLElement) {
    const pad = 8;
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxH = Math.max(180, vh - pad * 2);
    tip.style.maxHeight = `${maxH}px`;
    const tw = tip.offsetWidth;
    const th = Math.min(tip.scrollHeight, maxH);

    let left = anchor.left;
    if (left + tw > vw - pad) left = vw - pad - tw;
    if (left < pad) left = pad;

    const above = anchor.top - gap - th;
    const below = anchor.bottom + gap;
    let top = above;
    if (above < pad && below + th <= vh - pad)
        top = below;
    else if (above < pad)
        top = Math.max(pad, Math.min(below, vh - pad - th));

    return { left, top, maxHeight: maxH };
}

function ParticipantCard({
    participant,
    stats: s
}: {
    participant: ParticipantInfo;
    stats: SelfStats;
}) {
    const dest = getObservedDest(s);
    const events = eventsForUser(participant.id);
    const liveCount = s.participants.filter(p => p.connected).length;
    const media = liveUserMedia(participant.id, participant.self, s);
    const session = sessionStatusLabel(s, participant);
    const statusLabel = participant.connected
        ? participant.self ? "You" : "In voice"
        : "Disconnected";
    const statusDetail = participant.connected
        ? participant.self ? "You · connected to voice" : "Voice participant · connected to voice"
        : "Disconnected · still logged";
    const cardRef = useRef<HTMLDivElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [open, setOpen] = useState(false);

    const showTip = () => {
        if (closeTimer.current) {
            clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
        setOpen(true);
    };

    const hideTip = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setOpen(false), 280);
    };

    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const anchor = cardRef.current?.getBoundingClientRect();
            const tip = tipRef.current;
            if (!anchor || !tip) return;
            const next = placeTooltip(anchor, tip);
            tip.style.left = `${next.left}px`;
            tip.style.top = `${next.top}px`;
            tip.style.maxHeight = `${next.maxHeight}px`;
            tip.style.visibility = "visible";
        };
        place();
        const body = document.querySelector(".vc-ipa-body");
        body?.addEventListener("scroll", place, { passive: true });
        window.addEventListener("resize", place);
        window.addEventListener("pointermove", place);
        return () => {
            body?.removeEventListener("scroll", place);
            window.removeEventListener("resize", place);
            window.removeEventListener("pointermove", place);
        };
    }, [open]);

    const tooltip = open && mount
        ? ReactDOM.createPortal(
            <div
                ref={tipRef}
                className="vc-ipa-user-tooltip is-portal"
                role="tooltip"
                style={{ left: 0, top: 0, visibility: "hidden" }}
                onPointerEnter={showTip}
                onPointerLeave={hideTip}
            >
                <div className="vc-ipa-tooltip-head">
                    <UserAvatar src={participant.avatar} name={participant.name} />
                    <div>
                        <strong>{participant.name}</strong>
                        <span>{statusDetail}</span>
                    </div>
                </div>
                <div className="vc-ipa-tooltip-actions">
                    <button
                        type="button"
                        className="vc-ipa-tip-btn vc-ipa-tip-btn-primary"
                        onClick={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            setOpen(false);
                            void openUserProfile(participant.id);
                        }}
                    >
                        View profile
                    </button>
                    <button
                        type="button"
                        className="vc-ipa-tip-btn"
                        onClick={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            openParticipantMenu(e, participant);
                            setOpen(false);
                        }}
                    >
                        More
                    </button>
                </div>

                <TipSection title="Identity">
                    <TipRow label="Name" value={participant.name} />
                    <TipRow label="User ID" value={participant.id} code />
                    <TipRow label="Status" value={participant.connected ? "Connected to voice" : "Disconnected"} />
                    <TipRow label="Channel" value={s.channelName} />
                    <TipRow label="Peers" value={String(liveCount)} />
                    <TipRow label="First seen" value={formatClock(participant.firstSeen)} />
                    <TipRow label="Last join" value={formatClock(participant.lastJoin)} />
                    {!participant.connected && <TipRow label="Left" value={formatClock(participant.leftAt)} />}
                </TipSection>

                <TipSection title="Voice session">
                    <TipRow label="Session" value={session} />
                    <TipRow label="Quality" value={present(s.quality)} />
                    <TipRow label="RTC state" value={present(s.state)} />
                    <TipRow label="RTT" value={fmt(s.rttMs, " ms")} />
                    <TipRow label="Jitter" value={fmt(s.jitterMs, " ms", 1)} />
                    <TipRow label="Loss" value={fmt(s.packetLossPct, "%", 1)} />
                    <TipRow label="Bitrate" value={fmt(s.bitrateKbps, " kbps")} />
                    <TipRow label="Speaking" value={participant.connected && media.speaking ? "Yes" : "No"} />
                    <TipRow label="Video" value={participant.connected && media.video ? "Yes" : "No"} />
                    <TipRow label="Stream" value={participant.connected && media.streaming ? "Yes" : "No"} />
                    <TipRow label="Muted" value={participant.connected && media.muted ? "Yes" : "No"} />
                    <TipRow label="Deafened" value={participant.connected && media.deafened ? "Yes" : "No"} />
                </TipSection>

                <TipSection title="IP / geography / carrier">
                    <TipRow label="Observed IP" value={dest.endpoint} code />
                    <TipRow label="Path kind" value={dest.pathKind} />
                    <TipRow label="Regional area" value={dest.regionalArea} />
                    <TipRow label="Coordinates" value={dest.coords} />
                    <TipRow label="Carrier / ISP" value={dest.carrier} />
                    <TipRow label="Organization" value={dest.org} />
                    <TipRow label="ASN" value={dest.asn} />
                    <TipRow label="IP flags" value={dest.flags} />
                    <TipRow label="Authorized label" value={dest.authorized} />
                </TipSection>

                <TipSection title="This PC's link">
                    <TipRow label="Adapter" value={present(s.clientAdapter)} />
                    <TipRow label="Effective type" value={present(s.clientEffectiveType)} />
                    <TipRow label="Downlink" value={present(s.clientDownlink)} />
                    <TipRow label="Browser RTT" value={present(s.clientRtt)} />
                    <TipRow label="Local endpoint" value={present(s.localEndpoint)} code />
                    <TipRow label="Local ICE" value={iceLabel(s.localCandidateType)} />
                    <TipRow label="Local NIC (ICE)" value={nicLabel(s.localNetworkType)} />
                    <TipRow label="Capture IF" value={present(wiresharkSnapshot.interfaceName)} />
                </TipSection>

                <TipSection title="Observed endpoint">
                    <TipRow label="Observed endpoint" value={dest.endpoint} code />
                    <TipRow label="Authorized label" value={dest.authorized} />
                    <TipRow label="Regional area" value={dest.regionalArea} />
                    <TipRow label="Network" value={dest.isp} />
                    <TipRow label="Transport" value={dest.transport} />
                    <TipRow label="ICE path" value={dest.candidateType} />
                    <TipRow label="ICE candidate" value={present(s.selectedCandidateState)} />
                    <TipRow label="Packets" value={dest.packets} />
                    <TipRow label="Bytes" value={(s.bytesIn != null || s.bytesOut != null) ? `${fmtBytes(s.bytesIn ?? 0)} in · ${fmtBytes(s.bytesOut ?? 0)} out` : "-"} />
                    <TipRow label="Packets lost" value={s.packetsLost != null ? String(s.packetsLost) : "-"} />
                    <TipRow label="Pair RTT" value={fmt(s.pairRttMs, " ms", 1)} />
                    <TipRow label="Avail. bitrate" value={fmt(s.availableBitrateKbps, " kbps")} />
                    <TipRow label="Inter-packet Δ" value={dest.delta} />
                    <TipRow label="TTL / Hop limit" value={dest.ttl} />
                    <TipRow label="Security" value={dest.security} />
                    <TipRow label="DTLS state" value={present(s.dtlsState)} />
                    <TipRow label="DTLS cipher" value={present(s.dtlsCipher)} />
                    <TipRow label="SRTP cipher" value={present(s.srtpCipher)} />
                    <TipRow label="Audio codecs" value={s.audioCodecs.length ? s.audioCodecs.join(", ") : "-"} />
                    <TipRow label="Voice server" value={present(s.hostname)} />
                </TipSection>

                <DestinationMap dest={dest} compact />

                {events.length > 0 && (
                    <div className="vc-ipa-tooltip-events">
                        {events.map((event, i) => (
                            <div className={`vc-ipa-event vc-ipa-event-${event.type}`} key={`${event.time}-${i}`}>
                                <span className="vc-ipa-event-kind">{eventKind(event.type)}</span>
                                <span>{new Date(event.time).toLocaleTimeString()}</span>
                                <strong>{event.label}</strong>
                            </div>
                        ))}
                    </div>
                )}

                <p className="vc-ipa-tooltip-warning">
                    IP, region, carrier, and Wi-Fi/Ethernet describe the endpoint and
                    this PC's path visible to your client. Discord often uses shared
                    RTC/relay infrastructure, so this is not asserted to be this
                    participant's personal IP, GPS, or home ISP.
                </p>
            </div>,
            mount
        )
        : null;

    return (
        <div
            ref={cardRef}
            className={[
                "vc-ipa-user-card",
                participant.self ? "is-self" : "",
                participant.connected ? "" : "is-disconnected",
                open ? "is-open" : ""
            ].filter(Boolean).join(" ")}
            tabIndex={0}
            onPointerEnter={showTip}
            onPointerLeave={hideTip}
            onFocus={showTip}
            onBlur={hideTip}
        >
            <UserAvatar src={participant.avatar} name={participant.name} />
            <div className="vc-ipa-user-copy">
                <strong>{participant.name}</strong>
                <span>{statusLabel}</span>
            </div>
            {tooltip}
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
    const dest = getObservedDest(s);
    const liveCount = s.participants.filter(p => p.connected).length;
    const leftCount = s.participants.filter(p => !p.connected).length;
    const [chromeReady, setChromeReady] = useState(false);
    useLayoutEffect(() => {
        const frame = requestAnimationFrame(() => setChromeReady(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    return (
        <div
            id={ROOT_ID}
            className={[
                "vc-ipa-root",
                chromeReady ? "is-ready" : "",
                min ? "is-min" : "",
                max ? "is-max" : "",
                isDrag ? "is-dragging" : "",
                overlayResize ? "is-resizing" : "",
                overlayResize ? `is-resize-${overlayResize}` : "",
                s.connected || wiresharkSnapshot.running ? "is-live" : "",
                s.reconnecting ? "is-reconnect" : ""
            ].filter(Boolean).join(" ")}
            style={overlayBoxStyle(ui)}
            role="dialog"
            aria-label="Internet Protocol Assessment"
        >
            <div className="vc-ipa-card">
                <header
                    className="vc-ipa-bar"
                    onPointerDown={e => {
                        if (max || overlayResize) return;
                        const t = e.target as HTMLElement;
                        if (t.closest("button")) return;
                        dragging = true;
                        dragOffset = { x: e.clientX - uiState.pos.left, y: e.clientY - uiState.pos.top };
                        paint();
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                    }}
                    onPointerMove={e => {
                        if (!dragging || max) return;
                        uiState.pos = clampPos(
                            e.clientX - dragOffset.x,
                            e.clientY - dragOffset.y,
                            min ? MINIMIZED_OVERLAY_W : uiState.size.width,
                            min ? OVERLAY_BAR_H : uiState.size.height
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

                <div className={"vc-ipa-body vc-ipa-tech-body" + (min ? " is-collapsed" : "")} aria-hidden={min}>
                        <section className="vc-ipa-panel vc-ipa-people">
                            <div className="vc-ipa-section-head">
                                <div>
                                    <span className="vc-ipa-eyebrow">PEOPLE</span>
                                    <h2 className="vc-ipa-heading">{s.channelName}</h2>
                                </div>
                                <span className={"vc-ipa-status-pill" + (s.connected ? " is-ok" : s.reconnecting ? " is-warn" : "")}>
                                    {s.connected ? "LIVE" : s.reconnecting ? "WAIT" : "IDLE"}
                                </span>
                            </div>
                            <div className="vc-ipa-kpis vc-ipa-kpis-compact vc-ipa-kpis-4">
                                <div className="vc-ipa-kpi"><span>In voice</span><strong>{liveCount}</strong></div>
                                <div className="vc-ipa-kpi"><span>Seen</span><strong>{s.participants.length}</strong></div>
                                <div className="vc-ipa-kpi"><span>Left</span><strong>{leftCount}</strong></div>
                                <div className="vc-ipa-kpi"><span>You</span><strong>{s.muted ? "Muted" : s.speaking ? "Talking" : "Idle"}</strong></div>
                            </div>
                            <div className="vc-ipa-user-grid">
                                {s.participants.length
                                    ? s.participants.map(participant => (
                                        <ParticipantCard
                                            key={participant.id}
                                            participant={participant}
                                            stats={s}
                                        />
                                    ))
                                    : <div className="vc-ipa-empty">Join voice to see people here.</div>}
                            </div>
                        </section>

                        <section className="vc-ipa-panel">
                            <div className="vc-ipa-section-head">
                                <div>
                                    <span className="vc-ipa-eyebrow">YOUR CALL</span>
                                    <h2 className="vc-ipa-heading">Quality and transport</h2>
                                </div>
                                <span className={"vc-ipa-status-pill" + (s.connected ? " is-ok" : "")}>{s.quality}</span>
                            </div>
                            <div className="vc-ipa-kpis vc-ipa-kpis-compact">
                                <div className="vc-ipa-kpi"><span>RTT</span><strong>{fmt(s.rttMs, "ms")}</strong></div>
                                <div className="vc-ipa-kpi"><span>Jitter</span><strong>{fmt(s.jitterMs, "ms", 1)}</strong></div>
                                <div className="vc-ipa-kpi"><span>Loss</span><strong>{fmt(s.packetLossPct, "%", 1)}</strong></div>
                                <div className="vc-ipa-kpi"><span>Bitrate</span><strong>{fmt(s.bitrateKbps, "k")}</strong></div>
                                <div className="vc-ipa-kpi"><span>Lost pkts</span><strong>{s.packetsLost ?? "-"}</strong></div>
                            </div>
                            <div className="vc-ipa-grid vc-ipa-grid-tight">
                                <StatRow label="RTC" value={s.state} />
                                <StatRow label="DTLS" value={s.dtlsState} />
                                <StatRow label="SRTP" value={s.srtpCipher} />
                                <StatRow label="Codecs" value={s.audioCodecs.length ? s.audioCodecs.join(", ") : "-"} />
                                <StatRow label="Server" value={s.hostname} />
                                <StatRow label="Remote" value={dest.endpoint} />
                                <StatRow label="Location" value={dest.location} />
                                <StatRow label="Network" value={dest.isp} />
                                <StatRow label="ICE path" value={dest.candidateType} />
                                <StatRow label="Transport" value={dest.transport} />
                            </div>
                            <DestinationMap dest={dest} compact />
                        </section>

                        <section className="vc-ipa-panel">
                            <div className="vc-ipa-section-head">
                                <div>
                                    <span className="vc-ipa-eyebrow">CAPTURE</span>
                                    <h2 className="vc-ipa-heading">TShark flows</h2>
                                </div>
                                <span className={"vc-ipa-status-pill" + (wiresharkSnapshot.running ? " is-ok" : "")}>
                                    {wiresharkSnapshot.running ? "ACTIVE" : "OFF"}
                                </span>
                            </div>
                            <div className="vc-ipa-kpis vc-ipa-kpis-compact">
                                <div className="vc-ipa-kpi"><span>Frames</span><strong>{wiresharkSnapshot.packetsCaptured}</strong></div>
                                <div className="vc-ipa-kpi"><span>pps</span><strong>{Number(wiresharkSnapshot.packetsPerSecond ?? 0).toFixed(0)}</strong></div>
                                <div className="vc-ipa-kpi"><span>Flows</span><strong>{wiresharkSnapshot.connections.length}</strong></div>
                                <div className="vc-ipa-kpi"><span>Wire</span><strong>{fmtRate(wiresharkSnapshot.bitsPerSecond)}</strong></div>
                                <div className="vc-ipa-kpi"><span>Bytes</span><strong>{fmtBytes(wiresharkSnapshot.bytesCaptured)}</strong></div>
                            </div>
                            <div className="vc-ipa-grid vc-ipa-grid-tight">
                                <StatRow label="Interface" value={wiresharkSnapshot.interfaceName} />
                                <StatRow label="GeoIP" value={wiresharkSnapshot.geoEnabled ? "MaxMind + HTTP" : "HTTP lookup"} />
                            </div>
                            <div className="vc-ipa-counter-list">
                                {topCounters(wiresharkSnapshot.transportCounters, 4).map(([name, count]) => (
                                    <div className="vc-ipa-counter-row" key={`t-${name}`}>
                                        <ProtocolBadge value={name} />
                                        <strong>{count}</strong>
                                    </div>
                                ))}
                                {topCounters(wiresharkSnapshot.protocolCounters, 4).map(([name, count]) => (
                                    <div className="vc-ipa-counter-row" key={`p-${name}`}>
                                        <ProtocolBadge value={name} />
                                        <strong>{count}</strong>
                                    </div>
                                ))}
                            </div>
                            <div className="vc-ipa-table-scroll">
                                <div className="vc-ipa-flow-table vc-ipa-flow-table-compact">
                                    <div className="vc-ipa-flow-header">
                                        <span>L4 / App</span>
                                        <span>Src</span>
                                        <span>Dst</span>
                                        <span>Pkts</span>
                                        <span>Info</span>
                                    </div>
                                    {wiresharkSnapshot.connections.length
                                        ? wiresharkSnapshot.connections.slice(0, 8).map((c, i) => (
                                            <div
                                                className="vc-ipa-flow-row"
                                                key={`${c.src}-${c.dst}-${c.protocol}-${c.streamId}-${i}`}
                                                title={`${c.encrypted} · TTL ${c.ttl ?? c.hopLimit ?? "-"} · R${c.tcpRetransmissions ?? 0}/D${c.duplicateAcks ?? 0}/O${c.outOfOrder ?? 0} · ${c.dstAuthorizedLabel || c.srcAuthorizedLabel || c.dstLocation || ""}`}
                                            >
                                                <span className="vc-ipa-flow-protocol">
                                                    <ProtocolBadge value={c.transport || "IP"} />
                                                    <ProtocolBadge value={c.protocol || "OTHER"} />
                                                </span>
                                                <code>{c.src}:{c.sport ?? "-"}</code>
                                                <code>{c.dst}:{c.dport ?? "-"}</code>
                                                <span>{c.packets}</span>
                                                <span>{c.lastDeltaMs != null ? `${c.lastDeltaMs.toFixed(1)}ms` : "-"} {c.tlsSni || c.stunType || c.encrypted}</span>
                                            </div>
                                        ))
                                        : <div className="vc-ipa-empty">No flows yet.</div>}
                                </div>
                            </div>
                        </section>

                        <section className="vc-ipa-panel">
                            <div className="vc-ipa-section-head">
                                <div>
                                    <span className="vc-ipa-eyebrow">FRAME LOG</span>
                                    <h2 className="vc-ipa-heading">Recent packets</h2>
                                </div>
                                <span className="vc-ipa-count-pill">{wiresharkSnapshot.recentPackets?.length ?? 0}</span>
                            </div>
                            <div className="vc-ipa-table-scroll">
                                <div className="vc-ipa-packet-table vc-ipa-packet-table-compact">
                                    <div className="vc-ipa-packet-header">
                                        <span>No.</span>
                                        <span>Proto</span>
                                        <span>Src</span>
                                        <span>Dst</span>
                                        <span>Len</span>
                                        <span>Info</span>
                                    </div>
                                    {[...(wiresharkSnapshot.recentPackets ?? [])].reverse().slice(0, 10).map((p, i) => (
                                        <div className="vc-ipa-packet-row" key={`${p.number ?? i}-${p.time}`} title={p.info}>
                                            <code>{p.number ?? "-"}</code>
                                            <span className="vc-ipa-flow-protocol">
                                                <ProtocolBadge value={p.transport || "IP"} />
                                                <ProtocolBadge value={p.protocol || "OTHER"} />
                                            </span>
                                            <code>{p.src}:{p.sport ?? "-"}</code>
                                            <code>{p.dst}:{p.dport ?? "-"}</code>
                                            <span>{p.length}</span>
                                            <span>{p.stunType || p.tlsSni || p.dnsQuery || p.info}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </section>
                    </div>
            </div>
            {!min && !max && OVERLAY_EDGES.map(edge => (
                <div
                    key={edge}
                    className={`vc-ipa-resize vc-ipa-resize-${edge}`}
                    onPointerDown={e => startOverlayResize(edge, e)}
                    onPointerMove={moveOverlayResize}
                    onPointerUp={endOverlayResize}
                    onPointerCancel={endOverlayResize}
                />
            ))}
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
    const dest = getObservedDest(stats);
    for (const key of destLookupKeys(stats, dest))
        void ensureGeo(key);
    void syncVoiceCapture();
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

    uiState.size = clampSize(uiState.size.width || DEFAULT_OVERLAY_W, uiState.size.height || DEFAULT_OVERLAY_H);
    if (!uiState.pos.left && !uiState.pos.top)
        uiState.pos = defaultPos(uiState.size.width, uiState.size.height);
    else
        uiState.pos = clampPos(uiState.pos.left, uiState.pos.top, uiState.size.width, uiState.size.height);

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
    overlayResize = null;
    stats = EMPTY_STATS;
}

export default definePlugin({
    name: "Internet Protocol Assessment",
    description: "Connection overlay that starts localhost Wireshark/TShark capture automatically when you join a Discord voice channel.",
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
        },
        RTC_CONNECTION_STATE() {
            void refreshStats();
        }
    },

    async start() {
        await loadUiState();
        await ensureUi();
        void syncVoiceCapture();
    },

    stop() {
        if (saveTimer != null) clearTimeout(saveTimer);
        void DataStore.set(UI_STORE_KEY, uiState);
        void stopLocalCapture();
        teardownUi();
    }
});
