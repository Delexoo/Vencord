/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Live IP / protocol audit derived from local TShark summaries only.
 */

import { isPrivateIp } from "./sessionMatch";

export type CapturedFlow = {
    transport?: string;
    protocol: string;
    src: string;
    dst: string;
    sport: number | null;
    dport: number | null;
    packets: number;
    bytes: number;
    encrypted: string;
    srcLocation?: string;
    dstLocation?: string;
};

export type ProtocolFamily = "tcp" | "udp" | "icmp" | "other";

export type ProtocolMix = {
    name: string;
    family: ProtocolFamily;
    packets: number;
    bytes: number;
};

export type RegionRow = {
    label: string;
    packets: number;
    flows: number;
};

export type AuditFinding = {
    severity: "ok" | "warn" | "info";
    title: string;
    detail: string;
};

export type IceCandidateInfo = {
    side: "local" | "remote";
    ip: string;
    port: number | null;
    protocol: string;
    candidateType: string;
    selected: boolean;
};

export type IpSource = "capture" | "ice-local" | "ice-remote" | "voice-server" | "device-b";

export type PathKind = "relay" | "direct" | "lan" | "mixed" | "unknown";

export type IpInventoryRow = {
    key: string;
    ip: string;
    ports: number[];
    scope: "private" | "public";
    sources: IpSource[];
    iceType: string;
    selected: boolean;
    protocol: string;
    packets: number;
    bytes: number;
    location: string;
    role: string;
};

export type LiveAudit = {
    packets: number;
    bytes: number;
    flows: number;
    tcpPackets: number;
    udpPackets: number;
    icmpPackets: number;
    otherPackets: number;
    encryptedFlows: number;
    plaintextFlows: number;
    unknownCryptoFlows: number;
    publicIps: string[];
    privateIps: string[];
    regions: RegionRow[];
    mix: ProtocolMix[];
    findings: AuditFinding[];
};

const UDP_SET = new Set(["UDP", "DTLS", "DTLSV1.0", "DTLSV1.2", "DTLSV1.3", "SRTP", "RTP", "STUN", "TURN", "ICE", "QUIC", "MDNS", "DNS"]);
const TCP_SET = new Set(["TCP", "TLS", "TLSV1", "TLSV1.2", "TLSV1.3", "SSL", "HTTP", "HTTPS", "WEBSOCKET"]);
const ICMP_SET = new Set(["ICMP", "ICMPV6", "ARP"]);

export function protocolFamily(protocol: string, transport?: string): ProtocolFamily {
    const t = String(transport || "").toUpperCase();
    if (t === "TCP") return "tcp";
    if (t === "UDP") return "udp";
    if (t === "ICMP" || t === "ICMPV6") return "icmp";
    const p = String(protocol || "OTHER").toUpperCase();
    if (UDP_SET.has(p)) return "udp";
    if (TCP_SET.has(p)) return "tcp";
    if (ICMP_SET.has(p)) return "icmp";
    return "other";
}

function addIp(set: Set<string>, ip: string) {
    const v = String(ip || "").trim();
    if (!v || v === "-") return;
    set.add(v);
}

function locationOf(flow: CapturedFlow, side: "src" | "dst") {
    const raw = side === "src" ? flow.srcLocation : flow.dstLocation;
    const ip = side === "src" ? flow.src : flow.dst;
    if (raw && raw !== "Unknown") return raw;
    if (isPrivateIp(ip)) return "Private/LAN";
    return "Public / unknown region";
}

function findingTone(severity: AuditFinding["severity"]): string {
    switch (severity) {
        case "ok":
            return "ok";
        case "warn":
            return "warn";
        case "info":
            return "info";
        default: {
            const _never: never = severity;
            return _never;
        }
    }
}

export { findingTone };

export function buildLiveAudit(
    flows: CapturedFlow[],
    packetsCaptured: number,
    geoEnabled: boolean,
    bridgeRunning: boolean,
    lastError: string | null
): LiveAudit {
    const mixMap = new Map<string, ProtocolMix>();
    const regionMap = new Map<string, RegionRow>();
    const publicIps = new Set<string>();
    const privateIps = new Set<string>();
    let tcpPackets = 0;
    let udpPackets = 0;
    let icmpPackets = 0;
    let otherPackets = 0;
    let encryptedFlows = 0;
    let plaintextFlows = 0;
    let unknownCryptoFlows = 0;
    let bytes = 0;

    for (const flow of flows) {
        const proto = String(flow.protocol || "OTHER").toUpperCase();
        const family = protocolFamily(proto, flow.transport);
        const pkts = Number(flow.packets) || 0;
        const flowBytes = Number(flow.bytes) || 0;
        bytes += flowBytes;

        const mix = mixMap.get(proto) ?? { name: proto, family, packets: 0, bytes: 0 };
        mix.packets += pkts;
        mix.bytes += flowBytes;
        mixMap.set(proto, mix);

        if (family === "tcp") tcpPackets += pkts;
        else if (family === "udp") udpPackets += pkts;
        else if (family === "icmp") icmpPackets += pkts;
        else otherPackets += pkts;

        if (flow.encrypted === "Encrypted transport") encryptedFlows += 1;
        else if (flow.encrypted === "Plaintext protocol") plaintextFlows += 1;
        else unknownCryptoFlows += 1;

        addIp(isPrivateIp(flow.src) ? privateIps : publicIps, flow.src);
        addIp(isPrivateIp(flow.dst) ? privateIps : publicIps, flow.dst);

        for (const side of ["src", "dst"] as const) {
            const ip = side === "src" ? flow.src : flow.dst;
            if (!ip || ip === "-" || isPrivateIp(ip)) continue;
            const label = locationOf(flow, side);
            const row = regionMap.get(label) ?? { label, packets: 0, flows: 0 };
            row.packets += pkts;
            row.flows += 1;
            regionMap.set(label, row);
        }
    }

    const mix = [...mixMap.values()].sort((a, b) => b.packets - a.packets);
    const regions = [...regionMap.values()].sort((a, b) => b.packets - a.packets).slice(0, 8);
    const findings: AuditFinding[] = [];

    if (!bridgeRunning) {
        findings.push({
            severity: "warn",
            title: "Capture offline",
            detail: lastError || "Start wireshark_bridge.py on this machine to audit live packets."
        });
    } else if (packetsCaptured === 0) {
        findings.push({
            severity: "info",
            title: "Waiting for packets",
            detail: "The bridge is up. Generate traffic or join a session to fill TCP/UDP tables."
        });
    } else {
        findings.push({
            severity: "ok",
            title: "Live capture",
            detail: `${packetsCaptured.toLocaleString()} frames across ${flows.length} flows.`
        });
    }

    if (udpPackets > 0) {
        findings.push({
            severity: "ok",
            title: "UDP present",
            detail: `${udpPackets.toLocaleString()} UDP-family packets (includes RTP/DTLS/QUIC/STUN when TShark classifies them).`
        });
    }
    if (tcpPackets > 0) {
        findings.push({
            severity: "info",
            title: "TCP present",
            detail: `${tcpPackets.toLocaleString()} TCP-family packets (TLS/HTTPS/control).`
        });
    }
    if (plaintextFlows > 0) {
        findings.push({
            severity: "warn",
            title: "Plaintext protocol",
            detail: `${plaintextFlows} flow(s) classified as HTTP/FTP/TELNET. Payloads are not decoded.`
        });
    }
    if (encryptedFlows > 0) {
        findings.push({
            severity: "ok",
            title: "Encrypted transport",
            detail: `${encryptedFlows} flow(s) classified as TLS/DTLS/QUIC. Application payload is not inspected.`
        });
    }
    if (publicIps.size === 0 && flows.length > 0) {
        findings.push({
            severity: "info",
            title: "LAN only",
            detail: "No public destinations yet. Traffic is staying on private addresses."
        });
    }
    if (!geoEnabled && publicIps.size > 0) {
        findings.push({
            severity: "info",
            title: "Regions limited",
            detail: "Pass --geo-db GeoLite2-City.mmdb to map public IPs to city/region."
        });
    }
    if (publicIps.size >= 8) {
        findings.push({
            severity: "info",
            title: "Many public endpoints",
            detail: `${publicIps.size} unique public IPs in the current window.`
        });
    }

    findings.push({
        severity: "info",
        title: "GeoIP is endpoint geography",
        detail: "Public IPs and city labels are Discord RTC/server endpoints (or other destinations this machine talks to), not a participant's physical location."
    });

    findings.push({
        severity: "info",
        title: "Payload inspection",
        detail: "Not performed. This overlay only summarizes headers TShark already decoded."
    });

    return {
        packets: packetsCaptured,
        bytes,
        flows: flows.length,
        tcpPackets,
        udpPackets,
        icmpPackets,
        otherPackets,
        encryptedFlows,
        plaintextFlows,
        unknownCryptoFlows,
        publicIps: [...publicIps].slice(0, 64),
        privateIps: [...privateIps].slice(0, 32),
        regions,
        mix,
        findings
    };
}

export function parseEndpoint(raw: string): { ip: string; port: number | null; } | null {
    const v = String(raw || "").trim();
    if (!v || v === "-") return null;
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(v);
    if (bracket) return { ip: bracket[1], port: bracket[2] ? Number(bracket[2]) : null };
    const lastColon = v.lastIndexOf(":");
    if (lastColon > 0 && /^\d+$/.test(v.slice(lastColon + 1)) && v.indexOf(":") === lastColon)
        return { ip: v.slice(0, lastColon), port: Number(v.slice(lastColon + 1)) };
    return { ip: v, port: null };
}

function addPort(ports: number[], port: number | null) {
    if (port == null || !Number.isFinite(port) || ports.includes(port)) return;
    ports.push(port);
}

function sourceLabel(source: IpSource): string {
    switch (source) {
        case "capture":
            return "capture";
        case "ice-local":
            return "ICE local";
        case "ice-remote":
            return "ICE remote";
        case "voice-server":
            return "voice hostname";
        case "device-b":
            return "device B";
        default: {
            const _never: never = source;
            return _never;
        }
    }
}

export function pathKindLabel(kind: PathKind): string {
    switch (kind) {
        case "relay":
            return "Relay / Discord RTC";
        case "direct":
            return "Direct ICE path";
        case "lan":
            return "LAN / private path";
        case "mixed":
            return "Mixed paths";
        case "unknown":
            return "Path unknown";
        default: {
            const _never: never = kind;
            return _never;
        }
    }
}

function icePathKind(candidates: IceCandidateInfo[]): PathKind {
    const selected = candidates.filter(c => c.selected && c.side === "remote");
    const pool = selected.length ? selected : candidates.filter(c => c.side === "remote");
    if (!pool.length) return "unknown";
    const kinds = new Set(pool.map(c => {
        const t = String(c.candidateType || "").toLowerCase();
        if (t.includes("relay")) return "relay";
        if (isPrivateIp(c.ip)) return "lan";
        if (t.includes("host") || t.includes("srflx") || t.includes("prflx")) return "direct";
        return isPrivateIp(c.ip) ? "lan" : "relay";
    }));
    if (kinds.size > 1) return "mixed";
    const only = [...kinds][0];
    if (only === "relay" || only === "direct" || only === "lan") return only;
    return "unknown";
}

function roleFor(row: {
    scope: "private" | "public";
    sources: IpSource[];
    iceType: string;
    selected: boolean;
}): string {
    const ice = String(row.iceType || "").toLowerCase();
    if (row.sources.includes("ice-local")) return "This PC";
    if (row.sources.includes("device-b") && row.scope === "private") return "Device B / LAN";
    if (row.sources.includes("voice-server") || ice.includes("relay"))
        return row.selected ? "Discord RTC (selected)" : "Discord RTC / relay";
    if (row.sources.includes("ice-remote") && (ice.includes("host") || ice.includes("srflx") || ice.includes("prflx")))
        return row.selected ? "Remote ICE (selected path)" : "Remote ICE candidate";
    if (row.sources.includes("ice-remote"))
        return row.selected ? "Remote endpoint (selected)" : "Remote ICE candidate";
    if (row.scope === "private") return "Private / LAN";
    return "Public endpoint";
}

type InventoryAcc = {
    ip: string;
    ports: number[];
    scope: "private" | "public";
    sources: Set<IpSource>;
    iceType: string;
    selected: boolean;
    protocol: string;
    packets: number;
    bytes: number;
    location: string;
};

function upsertIp(
    map: Map<string, InventoryAcc>,
    ip: string,
    extra: {
        port?: number | null;
        source: IpSource;
        iceType?: string;
        selected?: boolean;
        protocol?: string;
        packets?: number;
        bytes?: number;
        location?: string;
    }
) {
    const key = String(ip || "").trim();
    if (!key || key === "-") return;
    const scope = isPrivateIp(key) ? "private" : "public";
    const cur = map.get(key) ?? {
        ip: key,
        ports: [],
        scope,
        sources: new Set<IpSource>(),
        iceType: "",
        selected: false,
        protocol: "",
        packets: 0,
        bytes: 0,
        location: scope === "private" ? "Private/LAN" : "Public / unknown region"
    };
    addPort(cur.ports, extra.port ?? null);
    cur.sources.add(extra.source);
    if (extra.iceType) cur.iceType = extra.iceType;
    if (extra.selected) cur.selected = true;
    if (extra.protocol) cur.protocol = extra.protocol;
    cur.packets += extra.packets || 0;
    cur.bytes += extra.bytes || 0;
    if (extra.location && extra.location !== "Unknown") cur.location = extra.location;
    map.set(key, cur);
}

export function inferPathKind(candidates: IceCandidateInfo[], rows: IpInventoryRow[]): PathKind {
    const fromIce = icePathKind(candidates);
    if (fromIce !== "unknown") return fromIce;
    const remotes = rows.filter(r => r.sources.includes("ice-remote") || r.role.includes("Discord") || r.scope === "public");
    if (remotes.some(r => r.role.includes("Remote ICE"))) return "direct";
    if (remotes.some(r => r.scope === "public")) return "relay";
    if (rows.some(r => r.scope === "private" && r.sources.includes("ice-remote"))) return "lan";
    return "unknown";
}

export function buildIpInventory(input: {
    flows: CapturedFlow[];
    deviceBFlows?: CapturedFlow[];
    ice?: IceCandidateInfo[];
    hostname?: string;
    remoteEndpoint?: string;
    localEndpoint?: string;
}): IpInventoryRow[] {
    const map = new Map<string, InventoryAcc>();

    const ingestFlow = (flow: CapturedFlow, source: IpSource) => {
        upsertIp(map, flow.src, {
            port: flow.sport,
            source,
            protocol: flow.transport || flow.protocol,
            packets: Number(flow.packets) || 0,
            bytes: Number(flow.bytes) || 0,
            location: locationOf(flow, "src")
        });
        upsertIp(map, flow.dst, {
            port: flow.dport,
            source,
            protocol: flow.transport || flow.protocol,
            packets: Number(flow.packets) || 0,
            bytes: Number(flow.bytes) || 0,
            location: locationOf(flow, "dst")
        });
    };

    for (const flow of input.flows ?? []) ingestFlow(flow, "capture");
    for (const flow of input.deviceBFlows ?? []) ingestFlow(flow, "device-b");

    for (const ice of input.ice ?? []) {
        upsertIp(map, ice.ip, {
            port: ice.port,
            source: ice.side === "local" ? "ice-local" : "ice-remote",
            iceType: ice.candidateType,
            selected: ice.selected,
            protocol: ice.protocol
        });
    }

    const local = parseEndpoint(input.localEndpoint || "");
    if (local) upsertIp(map, local.ip, { port: local.port, source: "ice-local", selected: true });

    const remote = parseEndpoint(input.remoteEndpoint || "");
    if (remote) upsertIp(map, remote.ip, { port: remote.port, source: "ice-remote", selected: true });

    const host = String(input.hostname || "").trim();
    if (host && host !== "-") {
        const parsed = parseEndpoint(host);
        if (parsed && (parsed.ip.includes(".") || parsed.ip.includes(":")))
            upsertIp(map, parsed.ip, { port: parsed.port, source: "voice-server", selected: true });
        else
            upsertIp(map, host, { source: "voice-server", selected: true, location: "Discord voice hostname" });
    }

    return [...map.values()]
        .map(row => {
            const sources = [...row.sources];
            const role = roleFor({
                scope: row.scope,
                sources,
                iceType: row.iceType,
                selected: row.selected
            });
            return {
                key: row.ip,
                ip: row.ip,
                ports: row.ports.sort((a, b) => a - b),
                scope: row.scope,
                sources,
                iceType: row.iceType,
                selected: row.selected,
                protocol: row.protocol,
                packets: row.packets,
                bytes: row.bytes,
                location: row.location,
                role
            };
        })
        .sort((a, b) => {
            if (a.selected !== b.selected) return a.selected ? -1 : 1;
            if (a.packets !== b.packets) return b.packets - a.packets;
            return a.ip.localeCompare(b.ip);
        });
}

export function formatIpPorts(row: IpInventoryRow): string {
    if (!row.ports.length) return row.ip;
    return `${row.ip}:${row.ports.slice(0, 4).join(",")}${row.ports.length > 4 ? "..." : ""}`;
}

export function formatIpSources(row: IpInventoryRow): string {
    return row.sources.map(sourceLabel).join(" · ");
}

export function formatBytes(n: number) {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatRate(n: number, suffix: string) {
    if (!Number.isFinite(n) || n < 0) return `0 ${suffix}`;
    if (n >= 1000) return `${n.toFixed(0)} ${suffix}`;
    return `${n.toFixed(1)} ${suffix}`;
}
