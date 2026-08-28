/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pair Device A and Device B capture summaries for a second-device test.
 */

export type FlowLike = {
    protocol: string;
    src: string;
    dst: string;
    sport: number | null;
    dport: number | null;
    packets: number;
    bytes: number;
    encrypted: string;
    lastSeen?: string;
};

export type SessionKind = "relay" | "direct" | "none";

export type SessionStatus =
    | "verified"
    | "partial"
    | "waiting"
    | "offline"
    | "no-match";

export type SessionHint = {
    hostname?: string;
    remoteEndpoint?: string;
    dtlsState?: string;
    srtpCipher?: string;
    rttMs?: number | null;
    packetLossPct?: number | null;
    jitterMs?: number | null;
    connected?: boolean;
};

export type SessionMatch = {
    status: SessionStatus;
    kind: SessionKind;
    title: string;
    protocol: string;
    encryption: string;
    hubLabel: string;
    hubEndpoint: string;
    deviceA: string;
    deviceB: string;
    packetsA: number;
    packetsB: number;
    notes: string[];
};

type Side = { ip: string; port: number | null; };

const UDP_FAMILY = new Set(["UDP", "DTLS", "SRTP", "RTP", "STUN", "TURN", "ICE", "QUIC"]);
const TCP_FAMILY = new Set(["TCP", "TLS", "SSL", "HTTP", "HTTPS"]);

export function sessionTitle(status: SessionStatus): string {
    switch (status) {
        case "verified":
            return "SESSION VERIFIED";
        case "partial":
            return "SESSION PARTIAL";
        case "waiting":
            return "WAITING FOR DEVICE B";
        case "offline":
            return "DEVICE B OFFLINE";
        case "no-match":
            return "NO MATCHING SESSION";
        default: {
            const _never: never = status;
            return _never;
        }
    }
}

function family(protocol: string): "udp" | "tcp" | "other" {
    const p = protocol.toUpperCase();
    if (UDP_FAMILY.has(p)) return "udp";
    if (TCP_FAMILY.has(p)) return "tcp";
    return "other";
}

export function isPrivateIp(ip: string): boolean {
    const v = String(ip || "").trim().toLowerCase();
    if (!v || v === "-") return false;
    if (v === "localhost" || v === "::1") return true;
    if (v.startsWith("127.")) return true;
    if (v.startsWith("10.")) return true;
    if (v.startsWith("192.168.")) return true;
    if (v.startsWith("169.254.")) return true;
    const m = /^172\.(\d+)\./.exec(v);
    if (m) {
        const n = Number(m[1]);
        return n >= 16 && n <= 31;
    }
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:")) return true;
    return false;
}

function endpoint(ip: string, port: number | null) {
    return port != null ? `${ip}:${port}` : ip;
}

function splitSides(flow: FlowLike): { local: Side; remote: Side; } {
    const srcPriv = isPrivateIp(flow.src);
    const dstPriv = isPrivateIp(flow.dst);
    if (srcPriv && !dstPriv) {
        return {
            local: { ip: flow.src, port: flow.sport },
            remote: { ip: flow.dst, port: flow.dport }
        };
    }
    if (dstPriv && !srcPriv) {
        return {
            local: { ip: flow.dst, port: flow.dport },
            remote: { ip: flow.src, port: flow.sport }
        };
    }
    return {
        local: { ip: flow.src, port: flow.sport },
        remote: { ip: flow.dst, port: flow.dport }
    };
}

function sameIp(a: string, b: string) {
    return String(a || "").toLowerCase() === String(b || "").toLowerCase() && !!a && a !== "-";
}

function hostFromHint(hint?: SessionHint): string | null {
    const ep = String(hint?.remoteEndpoint || "").trim();
    if (ep && ep !== "-") return ep.split(":")[0];
    const host = String(hint?.hostname || "").trim();
    if (host && host !== "-") return host;
    return null;
}

function scorePair(a: FlowLike, b: FlowLike, hintHost: string | null): { score: number; kind: SessionKind; } {
    const fa = family(a.protocol);
    const fb = family(b.protocol);
    if (fa === "other" || fb === "other" || fa !== fb) return { score: 0, kind: "none" };

    const as = splitSides(a);
    const bs = splitSides(b);
    let score = 4;
    let kind: SessionKind = "none";

    if (sameIp(as.remote.ip, bs.local.ip) || sameIp(bs.remote.ip, as.local.ip)) {
        kind = "direct";
        score += 12;
    } else if (sameIp(as.remote.ip, bs.remote.ip)) {
        kind = "relay";
        score += 10;
        if (as.remote.port != null && as.remote.port === bs.remote.port) score += 3;
    } else {
        return { score: 0, kind: "none" };
    }

    if (hintHost && (sameIp(as.remote.ip, hintHost) || sameIp(bs.remote.ip, hintHost)))
        score += 4;

    const pa = Math.max(1, a.packets);
    const pb = Math.max(1, b.packets);
    const ratio = pa > pb ? pa / pb : pb / pa;
    if (ratio <= 2.5) score += 2;
    if (a.packets >= 20 && b.packets >= 20) score += 2;

    return { score, kind };
}

function encryptionLabel(a: FlowLike, b: FlowLike, hint?: SessionHint) {
    const dtls = String(hint?.dtlsState || "").toLowerCase();
    const srtp = String(hint?.srtpCipher || "");
    if ((dtls && dtls !== "-") || (srtp && srtp !== "-")) return "DTLS/SRTP";

    const protos = `${a.protocol} ${b.protocol}`.toUpperCase();
    if (/\b(DTLS|SRTP)\b/.test(protos)) return "DTLS/SRTP";
    if (/\b(TLS|HTTPS|QUIC)\b/.test(protos)) return "TLS";
    if (a.encrypted === "Encrypted transport" || b.encrypted === "Encrypted transport")
        return "Encrypted transport";
    if (a.encrypted === "Plaintext protocol" || b.encrypted === "Plaintext protocol")
        return "Plaintext protocol";
    return a.protocol.toUpperCase() || "Unknown";
}

function emptyMatch(status: SessionStatus, notes: string[]): SessionMatch {
    return {
        status,
        kind: "none",
        title: sessionTitle(status),
        protocol: "-",
        encryption: "-",
        hubLabel: "-",
        hubEndpoint: "-",
        deviceA: "-",
        deviceB: "-",
        packetsA: 0,
        packetsB: 0,
        notes
    };
}

export function matchSecondDevice(
    deviceA: FlowLike[],
    deviceB: FlowLike[] | null,
    deviceBUrl: string,
    deviceBError: string | null,
    hint?: SessionHint
): SessionMatch {
    const url = String(deviceBUrl || "").trim();
    if (!url) {
        return emptyMatch("waiting", [
            "On Device B run the bridge with --lan so this PC can read it.",
            "Then set Device B bridge URL to http://DEVICE-B-LAN-IP:8765"
        ]);
    }

    if (deviceBError || deviceB == null) {
        return emptyMatch("offline", [
            deviceBError || "Device B bridge did not respond.",
            "Confirm Device B used --lan and Windows Firewall allows port 8765."
        ]);
    }

    const hintHost = hostFromHint(hint);
    const aFlows = [...deviceA].sort((x, y) => y.packets - x.packets);
    const bFlows = [...deviceB].sort((x, y) => y.packets - x.packets);

    let best: { a: FlowLike; b: FlowLike; score: number; kind: SessionKind; } | null = null;
    for (const a of aFlows) {
        for (const b of bFlows) {
            const next = scorePair(a, b, hintHost);
            if (next.score > 0 && (!best || next.score > best.score))
                best = { a, b, score: next.score, kind: next.kind };
        }
    }

    if (!best) {
        return emptyMatch("no-match", [
            "Both bridges are up, but no complementary UDP/TCP session lined up yet.",
            "Join the same voice channel on both devices, then wait a few seconds."
        ]);
    }

    const as = splitSides(best.a);
    const bs = splitSides(best.b);
    const relay = best.kind === "relay";
    const pa = best.a.packets;
    const pb = best.b.packets;
    const ratio = Math.max(pa, pb) / Math.max(1, Math.min(pa, pb));
    const bothBusy = pa >= 30 && pb >= 30 && ratio <= 2.5;
    const status: SessionStatus = bothBusy ? "verified" : "partial";

    const notes: string[] = [];
    if (relay) {
        notes.push("Both devices talk to the same RTC server, not directly to each other.");
    } else {
        notes.push("Flows look like a direct peer path between the two devices.");
    }
    if (bothBusy) notes.push("Packet counts are active on both sides.");
    else notes.push("Match found, but packet counts are still low or uneven.");

    if (hint?.connected) {
        const rtt = hint.rttMs != null ? `${Math.round(hint.rttMs)} ms RTT` : null;
        const loss = hint.packetLossPct != null ? `${hint.packetLossPct.toFixed(1)}% loss` : null;
        const jitter = hint.jitterMs != null ? `${hint.jitterMs.toFixed(1)} ms jitter` : null;
        const quality = [rtt, loss, jitter].filter(Boolean).join(", ");
        if (quality) notes.push(`Device A overlay: ${quality}.`);
    }

    const proto = family(best.a.protocol) === "udp" ? "UDP" : best.a.protocol.toUpperCase();

    return {
        status,
        kind: best.kind,
        title: sessionTitle(status),
        protocol: proto,
        encryption: encryptionLabel(best.a, best.b, hint),
        hubLabel: relay ? "Discord RTC" : "Peer path",
        hubEndpoint: endpoint(as.remote.ip, as.remote.port),
        deviceA: endpoint(as.local.ip, as.local.port),
        deviceB: endpoint(bs.local.ip, bs.local.port),
        packetsA: pa,
        packetsB: pb,
        notes
    };
}
