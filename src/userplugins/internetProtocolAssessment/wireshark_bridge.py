#!/usr/bin/env python3
"""
Local Wireshark/TShark bridge for the Vencord "Internet Protocol Assessment" plugin.

Safety properties:
- Default bind is 127.0.0.1. Use --lan / --bind for Device B on the private LAN.
- Captures traffic from the local machine's selected interface.
- Uses TShark for capture; the plugin never gets raw packet bytes.
- Keeps an in-memory connection summary and a PCAPNG capture file.
- Does not decrypt traffic or attempt to intercept other hosts' traffic.

Usage:
  python wireshark_bridge.py --list
  python wireshark_bridge.py --interface 1
  python wireshark_bridge.py --interface 1 --geo-db GeoLite2-City.mmdb
  python wireshark_bridge.py --interface 1 --authorized-devices authorized_devices.example.json
  python wireshark_bridge.py --interface 1 --lan --token secret
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.server
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import threading
from collections import OrderedDict
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

try:
    import geoip2.database  # optional: pip install geoip2
except Exception:
    geoip2 = None

HOST = "127.0.0.1"
PORT = 8765
MAX_CONNECTIONS = 150
MAX_PACKET_SUMMARY_LINES = 5000
MAX_RECENT_PACKETS = 500
AUTH_TOKEN = None

COMMON_TSHARK = [
    r"C:\Program Files\Wireshark\tshark.exe",
    r"C:\Program Files (x86)\Wireshark\tshark.exe",
    "/usr/bin/tshark",
    "/usr/local/bin/tshark",
    "/opt/homebrew/bin/tshark",
    "/Applications/Wireshark.app/Contents/MacOS/tshark",
]

state_lock = threading.Lock()
state = {
    "running": False,
    "interfaceName": "-",
    "captureFile": "-",
    "packetsCaptured": 0,
    "connections": OrderedDict(),
    "recentPackets": [],
    "protocolCounters": {},
    "transportCounters": {},
    "bytesCaptured": 0,
    "startedAt": "",
    "lastError": None,
    "updatedAt": "",
}

stop_event = threading.Event()
tshark_process = None

geo_reader = None
geo_db_path = None
geo_cache = {}
authorized_devices = {}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def guessed_lan_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except Exception:
        return "THIS-PC-LAN-IP"
    finally:
        sock.close()


def exe(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    for path in COMMON_TSHARK:
        if os.path.isfile(path):
            return path
    raise RuntimeError(
        f"{name} was not found in PATH. Install Wireshark/TShark and add it to PATH."
    )


def list_interfaces():
    tshark = exe("tshark")
    result = subprocess.run(
        [tshark, "-D"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Unable to enumerate interfaces.")
    return result.stdout.strip()



def init_geoip(database_path: str | None):
    """Load a local MaxMind GeoLite2/GeoIP2 City database if provided."""
    global geo_reader, geo_db_path

    if not database_path:
        return

    if geoip2 is None:
        raise RuntimeError(
            "GeoIP database requested but the geoip2 package is not installed. "
            "Run: pip install geoip2"
        )

    path = Path(database_path).expanduser().resolve()
    if not path.exists():
        raise RuntimeError(f"GeoIP database not found: {path}")

    geo_reader = geoip2.database.Reader(str(path))
    geo_db_path = str(path)


def geo_for_ip(value: str):
    """
    Return coarse geographic information for a public IP.

    Private, loopback, link-local, multicast, reserved, and unspecified
    addresses are deliberately not geolocated.
    """
    if not value:
        return {
            "scope": "Unknown",
            "city": None,
            "region": None,
            "country": None,
            "countryCode": None,
            "latitude": None,
            "longitude": None,
        }

    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return {
            "scope": "Unknown",
            "city": None,
            "region": None,
            "country": None,
            "countryCode": None,
            "latitude": None,
            "longitude": None,
        }

    if not ip.is_global:
        return {
            "scope": "Private/LAN",
            "city": None,
            "region": None,
            "country": None,
            "countryCode": None,
            "latitude": None,
            "longitude": None,
        }

    cached = geo_cache.get(value)
    if cached is not None:
        if (
            cached.get("latitude") is None
            and not cached.get("_httpPending")
            and not cached.get("_httpTried")
            and cached.get("scope") == "Public"
        ):
            cached["_httpPending"] = True
            threading.Thread(target=http_geo_fill, args=(value,), daemon=True).start()
        return cached

    result = {
        "scope": "Public",
        "city": None,
        "region": None,
        "country": None,
        "countryCode": None,
        "latitude": None,
        "longitude": None,
    }

    if geo_reader is not None:
        try:
            record = geo_reader.city(value)
            result.update({
                "city": record.city.name,
                "region": (
                    record.subdivisions.most_specific.name
                    if record.subdivisions
                    else None
                ),
                "country": record.country.name,
                "countryCode": record.country.iso_code,
                "latitude": record.location.latitude,
                "longitude": record.location.longitude,
            })
        except Exception:
            # A public IP can legitimately have no entry in the local database.
            pass

    geo_cache[value] = result
    if result.get("latitude") is None:
        result["_httpPending"] = True
        threading.Thread(target=http_geo_fill, args=(value,), daemon=True).start()
    return result


def http_geo_fill(value: str):
    try:
        req = Request(
            f"http://ip-api.com/json/{value}?fields=status,city,regionName,country,countryCode,lat,lon,isp,org,as",
            headers={"User-Agent": "InternetProtocolAssessment/1.0"},
        )
        with urlopen(req, timeout=1.5) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
        current = dict(geo_cache.get(value) or {})
        current["_httpPending"] = False
        current["_httpTried"] = True
        if payload.get("status") != "success":
            geo_cache[value] = current
            return
        current.update({
            "scope": "Public",
            "city": payload.get("city"),
            "region": payload.get("regionName"),
            "country": payload.get("country"),
            "countryCode": payload.get("countryCode"),
            "latitude": payload.get("lat"),
            "longitude": payload.get("lon"),
            "isp": payload.get("isp"),
            "org": payload.get("org"),
            "as": payload.get("as"),
        })
        geo_cache[value] = current
        with state_lock:
            for conn in state["connections"].values():
                if conn.get("dst") == value:
                    conn["dstGeo"] = current
                    conn["dstLocation"] = geo_label(current)
                if conn.get("src") == value:
                    conn["srcGeo"] = current
                    conn["srcLocation"] = geo_label(current)
    except Exception:
        current = dict(geo_cache.get(value) or {})
        current["_httpPending"] = False
        current["_httpTried"] = True
        geo_cache[value] = current


def geo_label(geo: dict) -> str:
    if geo.get("scope") == "Private/LAN":
        return "Private/LAN"

    parts = [
        geo.get("city"),
        geo.get("region"),
        geo.get("countryCode") or geo.get("country"),
    ]
    parts = [str(x) for x in parts if x]
    return ", ".join(parts) if parts else str(geo.get("scope") or "Unknown")


def load_authorized_devices(path: str | None):
    """
    Optional JSON mapping for devices the operator owns or has explicit permission to test.

    Example:
      {
        "192.168.1.40": "Pixel-Test",
        "2001:db8::10": "Lab-Laptop"
      }

    This does not discover identities. It only labels IPs the operator supplied.
    """
    global authorized_devices
    if not path:
        return

    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise RuntimeError(f"Authorized-device map not found: {p}")

    raw = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise RuntimeError("Authorized-device map must be a JSON object of IP -> label")

    clean = {}
    for ip_value, label in raw.items():
        try:
            ipaddress.ip_address(str(ip_value))
        except ValueError:
            continue
        clean[str(ip_value)] = str(label)[:120]

    authorized_devices = clean


def authorized_label(ip_value: str):
    return authorized_devices.get(ip_value)



def update_connection(fields: list[str]):
    """
    Deep decoded metadata for the local capture interface.

    Important: this does NOT infer a Discord participant's personal IP.
    It records packet/flow metadata visible to the local machine and can
    optionally label operator-supplied authorized test-device IPs.
    """
    fields = fields + [""] * (58 - len(fields))
    (
        frame_number, timestamp, time_relative, time_delta,
        app_protocol, info,
        eth_src, eth_dst, eth_type,
        ip4_src, ip4_dst, ip6_src, ip6_dst,
        ip_ttl, ipv6_hlim, ip_id, ip_flags, ip_frag_offset,
        ip_dscp, ip_ecn, ipv6_tclass,
        tcp_sport, tcp_dport, udp_sport, udp_dport,
        frame_len, cap_len,
        ip_proto, ipv6_next,
        tcp_stream, udp_stream,
        tcp_flags, tcp_seq, tcp_ack, tcp_len, tcp_window,
        tcp_window_scaled, tcp_bytes_in_flight, tcp_ack_rtt,
        tcp_retx, tcp_fast_retx, tcp_dup_ack, tcp_ooo,
        udp_len,
        dns_name, dns_rcode,
        tls_version, tls_sni, tls_alpn,
        quic_version, quic_dcid, quic_scid,
        stun_type, stun_xor_ipv4, stun_xor_ipv6, stun_xor_port,
        expert_severity, expert_message,
    ) = fields[:58]

    src = ip4_src or ip6_src or "-"
    dst = ip4_dst or ip6_dst or "-"
    app_protocol = (app_protocol or "OTHER").upper()

    def as_int(value):
        try:
            return int(value, 0) if value else None
        except Exception:
            try:
                return int(value) if value else None
            except Exception:
                return None

    def as_float(value):
        try:
            return float(value) if value else None
        except Exception:
            return None

    tcp_sport_i = as_int(tcp_sport)
    tcp_dport_i = as_int(tcp_dport)
    udp_sport_i = as_int(udp_sport)
    udp_dport_i = as_int(udp_dport)
    frame_len_i = as_int(frame_len) or 0
    cap_len_i = as_int(cap_len) or frame_len_i

    if tcp_sport_i is not None or tcp_dport_i is not None:
        transport = "TCP"
        sport_i, dport_i = tcp_sport_i, tcp_dport_i
        stream_id = tcp_stream or None
    elif udp_sport_i is not None or udp_dport_i is not None:
        transport = "UDP"
        sport_i, dport_i = udp_sport_i, udp_dport_i
        stream_id = udp_stream or None
    elif app_protocol == "ICMP":
        transport = "ICMP"
        sport_i = dport_i = None
        stream_id = None
    elif app_protocol == "ICMPV6":
        transport = "ICMPV6"
        sport_i = dport_i = None
        stream_id = None
    else:
        transport = f"IP-{ip_proto or ipv6_next}" if (ip_proto or ipv6_next) else "OTHER"
        sport_i = dport_i = None
        stream_id = None

    flags_i = as_int(tcp_flags)
    flag_names = []
    if flags_i is not None:
        for mask, name in [
            (0x001, "FIN"), (0x002, "SYN"), (0x004, "RST"), (0x008, "PSH"),
            (0x010, "ACK"), (0x020, "URG"), (0x040, "ECE"), (0x080, "CWR")
        ]:
            if flags_i & mask:
                flag_names.append(name)

    anomalies = []
    if tcp_retx:
        anomalies.append("Retransmission")
    if tcp_fast_retx:
        anomalies.append("Fast retransmission")
    if tcp_dup_ack:
        anomalies.append("Duplicate ACK")
    if tcp_ooo:
        anomalies.append("Out-of-order")
    if expert_message:
        anomalies.append(expert_message)

    if app_protocol in {"TLS", "TLSV1.2", "TLSV1.3", "DTLS", "QUIC", "SRTP"}:
        security = "Encrypted transport"
    elif app_protocol in {"HTTP", "FTP", "TELNET"}:
        security = "Plaintext protocol"
    else:
        security = "Unknown"

    src_geo = geo_for_ip(src)
    dst_geo = geo_for_ip(dst)

    packet = {
        "number": as_int(frame_number),
        "time": timestamp or utc_now(),
        "relativeMs": round((as_float(time_relative) or 0) * 1000, 3),
        "deltaMs": round((as_float(time_delta) or 0) * 1000, 3),
        "transport": transport,
        "protocol": app_protocol,
        "info": info or "-",
        "srcMac": eth_src or "-",
        "dstMac": eth_dst or "-",
        "etherType": eth_type or None,
        "src": src,
        "dst": dst,
        "srcAuthorizedLabel": authorized_label(src),
        "dstAuthorizedLabel": authorized_label(dst),
        "sport": sport_i,
        "dport": dport_i,
        "length": frame_len_i,
        "capturedLength": cap_len_i,
        "ttl": as_int(ip_ttl),
        "hopLimit": as_int(ipv6_hlim),
        "ipId": ip_id or None,
        "ipFlags": ip_flags or None,
        "fragmentOffset": as_int(ip_frag_offset),
        "dscp": as_int(ip_dscp),
        "ecn": as_int(ip_ecn),
        "ipv6TrafficClass": as_int(ipv6_tclass),
        "streamId": stream_id,
        "tcpFlags": ",".join(flag_names) if flag_names else None,
        "tcpSeq": as_int(tcp_seq),
        "tcpAck": as_int(tcp_ack),
        "tcpPayloadBytes": as_int(tcp_len),
        "tcpWindow": as_int(tcp_window),
        "tcpWindowScaled": as_int(tcp_window_scaled),
        "tcpBytesInFlight": as_int(tcp_bytes_in_flight),
        "tcpAckRttMs": round((as_float(tcp_ack_rtt) or 0) * 1000, 3) if tcp_ack_rtt else None,
        "udpLength": as_int(udp_len),
        "dnsQuery": dns_name or None,
        "dnsRcode": dns_rcode or None,
        "tlsVersion": tls_version or None,
        "tlsSni": tls_sni or None,
        "tlsAlpn": tls_alpn or None,
        "quicVersion": quic_version or None,
        "quicDcid": quic_dcid or None,
        "quicScid": quic_scid or None,
        "stunType": stun_type or None,
        "stunXorMappedAddress": stun_xor_ipv4 or stun_xor_ipv6 or None,
        "stunXorMappedPort": as_int(stun_xor_port),
        "expertSeverity": expert_severity or None,
        "anomalies": anomalies,
        "security": security,
        "srcLocation": geo_label(src_geo),
        "dstLocation": geo_label(dst_geo),
    }

    key = (transport, app_protocol, src, dst, sport_i, dport_i, stream_id)

    with state_lock:
        current = state["connections"].get(key)
        if current is None:
            current = {
                "transport": transport,
                "protocol": app_protocol,
                "src": src,
                "dst": dst,
                "srcAuthorizedLabel": authorized_label(src),
                "dstAuthorizedLabel": authorized_label(dst),
                "sport": sport_i,
                "dport": dport_i,
                "streamId": stream_id,
                "packets": 0,
                "bytes": 0,
                "firstSeen": timestamp or utc_now(),
                "lastSeen": timestamp or utc_now(),
                "encrypted": security,
                "srcGeo": src_geo,
                "dstGeo": dst_geo,
                "srcLocation": geo_label(src_geo),
                "dstLocation": geo_label(dst_geo),
                "tcpRetransmissions": 0,
                "tcpFastRetransmissions": 0,
                "duplicateAcks": 0,
                "outOfOrder": 0,
                "minDeltaMs": None,
                "maxDeltaMs": None,
                "lastDeltaMs": None,
                "minAckRttMs": None,
                "maxAckRttMs": None,
                "lastAckRttMs": None,
                "lastInfo": "-",
                "tcpFlags": None,
                "tcpWindow": None,
                "tcpWindowScaled": None,
                "tcpBytesInFlight": None,
                "ttl": None,
                "hopLimit": None,
                "dscp": None,
                "ecn": None,
                "fragmentOffset": None,
                "dnsQuery": None,
                "dnsRcode": None,
                "tlsVersion": None,
                "tlsSni": None,
                "tlsAlpn": None,
                "quicVersion": None,
                "quicDcid": None,
                "quicScid": None,
                "stunType": None,
                "stunXorMappedAddress": None,
                "stunXorMappedPort": None,
                "expertSeverity": None,
                "expertMessageCount": 0,
            }
            state["connections"][key] = current

        current["packets"] += 1
        current["bytes"] += frame_len_i
        current["lastSeen"] = timestamp or utc_now()
        current["encrypted"] = security
        current["lastInfo"] = info or "-"
        current["tcpFlags"] = packet["tcpFlags"]
        current["tcpWindow"] = packet["tcpWindow"]
        current["tcpWindowScaled"] = packet["tcpWindowScaled"]
        current["tcpBytesInFlight"] = packet["tcpBytesInFlight"]
        current["ttl"] = packet["ttl"]
        current["hopLimit"] = packet["hopLimit"]
        current["dscp"] = packet["dscp"]
        current["ecn"] = packet["ecn"]
        current["fragmentOffset"] = packet["fragmentOffset"]
        current["dnsQuery"] = packet["dnsQuery"]
        current["dnsRcode"] = packet["dnsRcode"]
        current["tlsVersion"] = packet["tlsVersion"]
        current["tlsSni"] = packet["tlsSni"]
        current["tlsAlpn"] = packet["tlsAlpn"]
        current["quicVersion"] = packet["quicVersion"]
        current["quicDcid"] = packet["quicDcid"]
        current["quicScid"] = packet["quicScid"]
        current["stunType"] = packet["stunType"]
        current["stunXorMappedAddress"] = packet["stunXorMappedAddress"]
        current["stunXorMappedPort"] = packet["stunXorMappedPort"]
        current["expertSeverity"] = packet["expertSeverity"]

        delta_ms = packet["deltaMs"]
        current["lastDeltaMs"] = delta_ms
        current["minDeltaMs"] = delta_ms if current["minDeltaMs"] is None else min(current["minDeltaMs"], delta_ms)
        current["maxDeltaMs"] = delta_ms if current["maxDeltaMs"] is None else max(current["maxDeltaMs"], delta_ms)

        ack_ms = packet["tcpAckRttMs"]
        if ack_ms is not None:
            current["lastAckRttMs"] = ack_ms
            current["minAckRttMs"] = ack_ms if current["minAckRttMs"] is None else min(current["minAckRttMs"], ack_ms)
            current["maxAckRttMs"] = ack_ms if current["maxAckRttMs"] is None else max(current["maxAckRttMs"], ack_ms)

        if tcp_retx:
            current["tcpRetransmissions"] += 1
        if tcp_fast_retx:
            current["tcpFastRetransmissions"] += 1
        if tcp_dup_ack:
            current["duplicateAcks"] += 1
        if tcp_ooo:
            current["outOfOrder"] += 1
        if expert_message:
            current["expertMessageCount"] += 1

        state["recentPackets"].append(packet)
        if len(state["recentPackets"]) > MAX_RECENT_PACKETS:
            del state["recentPackets"][:-MAX_RECENT_PACKETS]

        state["protocolCounters"][app_protocol] = state["protocolCounters"].get(app_protocol, 0) + 1
        state["transportCounters"][transport] = state["transportCounters"].get(transport, 0) + 1
        state["packetsCaptured"] += 1
        state["bytesCaptured"] += frame_len_i
        state["updatedAt"] = utc_now()

        while len(state["connections"]) > MAX_CONNECTIONS:
            state["connections"].popitem(last=False)


def drain_stderr(proc: subprocess.Popen, bucket: list[str]):
    if proc.stderr is None:
        return
    for line in proc.stderr:
        text = line.strip()
        if text:
            bucket.append(text)
            if len(bucket) > 80:
                del bucket[:40]


def capture_worker(interface: str, capture_file: Path):
    global tshark_process

    try:
        tshark = exe("tshark")
        capture_file.parent.mkdir(parents=True, exist_ok=True)
        stderr_lines: list[str] = []

        # TShark writes raw packets to the pcapng and simultaneously emits
        # selected metadata as line-buffered fields to stdout.
        command = [
            tshark,
            "-i", interface,
            "-p",  # no promiscuous mode
            "-l",
            "-n",
            "-P",  # print decoded packet information while -w saves PCAPNG
            "-w", str(capture_file),
            "-T", "fields",
            "-E", "header=n",
            "-E", "separator=|",
            "-E", "occurrence=f",
            "-e", "frame.number",
            "-e", "frame.time_epoch",
            "-e", "frame.time_relative",
            "-e", "frame.time_delta_displayed",
            "-e", "_ws.col.Protocol",
            "-e", "_ws.col.Info",
            "-e", "eth.src",
            "-e", "eth.dst",
            "-e", "eth.type",
            "-e", "ip.src",
            "-e", "ip.dst",
            "-e", "ipv6.src",
            "-e", "ipv6.dst",
            "-e", "ip.ttl",
            "-e", "ipv6.hlim",
            "-e", "ip.id",
            "-e", "ip.flags",
            "-e", "ip.frag_offset",
            "-e", "ip.dsfield.dscp",
            "-e", "ip.dsfield.ecn",
            "-e", "ipv6.tclass",
            "-e", "tcp.srcport",
            "-e", "tcp.dstport",
            "-e", "udp.srcport",
            "-e", "udp.dstport",
            "-e", "frame.len",
            "-e", "frame.cap_len",
            "-e", "ip.proto",
            "-e", "ipv6.nxt",
            "-e", "tcp.stream",
            "-e", "udp.stream",
            "-e", "tcp.flags",
            "-e", "tcp.seq",
            "-e", "tcp.ack",
            "-e", "tcp.len",
            "-e", "tcp.window_size_value",
            "-e", "tcp.window_size",
            "-e", "tcp.analysis.bytes_in_flight",
            "-e", "tcp.analysis.ack_rtt",
            "-e", "tcp.analysis.retransmission",
            "-e", "tcp.analysis.fast_retransmission",
            "-e", "tcp.analysis.duplicate_ack",
            "-e", "tcp.analysis.out_of_order",
            "-e", "udp.length",
            "-e", "dns.qry.name",
            "-e", "dns.flags.rcode",
            "-e", "tls.handshake.version",
            "-e", "tls.handshake.extensions_server_name",
            "-e", "tls.handshake.extensions_alpn_str",
            "-e", "quic.version",
            "-e", "quic.dcid",
            "-e", "quic.scid",
            "-e", "stun.type",
            "-e", "stun.att.ipv4",
            "-e", "stun.att.ipv6",
            "-e", "stun.att.port",
            "-e", "_ws.expert.severity",
            "-e", "_ws.expert.message",
        ]

        tshark_process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

        threading.Thread(
            target=drain_stderr,
            args=(tshark_process, stderr_lines),
            daemon=True,
        ).start()

        with state_lock:
            state["running"] = True
            if not state["startedAt"]:
                state["startedAt"] = utc_now()
            state["interfaceName"] = interface
            state["captureFile"] = str(capture_file)
            state["lastError"] = None
            state["updatedAt"] = utc_now()

        assert tshark_process.stdout is not None
        for line in tshark_process.stdout:
            if stop_event.is_set():
                break
            update_connection(line.rstrip("\r\n").split("|"))

        rc = tshark_process.wait(timeout=5)
        stderr = "\n".join(stderr_lines).strip()

        with state_lock:
            state["running"] = False
            if rc not in (0, None) and stderr:
                state["lastError"] = stderr[-1500:]
            elif not state["packetsCaptured"] and stderr:
                state["lastError"] = stderr[-1500:]
            state["updatedAt"] = utc_now()

    except Exception as exc:
        with state_lock:
            state["running"] = False
            state["lastError"] = str(exc)
            state["updatedAt"] = utc_now()


class Handler(http.server.BaseHTTPRequestHandler):
    def _authorized(self) -> bool:
        if not AUTH_TOKEN:
            return True
        parsed = urlparse(self.path)
        query_token = (parse_qs(parsed.query).get("token") or [None])[0]
        header = self.headers.get("X-Ipa-Token") or ""
        auth = self.headers.get("Authorization") or ""
        bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        return AUTH_TOKEN in {query_token, header, bearer}

    def _send_json(self, payload, status=200):
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        origin = self.headers.get("Origin") or "*"
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Ipa-Token")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin") or "*"
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Ipa-Token")
        self.end_headers()

    def do_GET(self):
        if not self._authorized():
            self._send_json({"error": "Unauthorized"}, 401)
            return

        path = urlparse(self.path).path
        if path == "/interfaces":
            try:
                output = list_interfaces()
                self._send_json({"interfaces": output.splitlines()})
            except Exception as exc:
                self._send_json({"error": str(exc)}, 500)
            return

        if path == "/snapshot":
            with state_lock:
                elapsed = 0.0
                if state.get("startedAt"):
                    try:
                        elapsed = max(0.001, (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(state["startedAt"])).total_seconds())
                    except Exception:
                        elapsed = 0.0

                payload = {
                    **state,
                    "connections": list(state["connections"].values()),
                    "recentPackets": list(state["recentPackets"]),
                    "geoDatabase": geo_db_path or "-",
                    "geoEnabled": geo_reader is not None,
                    "uptimeSeconds": elapsed,
                    "packetsPerSecond": (state["packetsCaptured"] / elapsed) if elapsed else 0,
                    "bitsPerSecond": ((state["bytesCaptured"] * 8) / elapsed) if elapsed else 0,
                }
            self._send_json(payload)
            return

        if path == "/health":
            self._send_json({"ok": True, "time": utc_now()})
            return

        if path == "/shutdown":
            stop_event.set()
            if tshark_process and tshark_process.poll() is None:
                try:
                    tshark_process.terminate()
                except Exception:
                    pass
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            self._send_json({"ok": True, "stopped": True})
            return

        self._send_json({"error": "Not found"}, 404)

    def log_message(self, fmt, *args):
        pass


def main():
    global HOST, PORT, AUTH_TOKEN

    parser = argparse.ArgumentParser()
    parser.add_argument("--interface", default=None, help="TShark interface number/name; use --list first")
    parser.add_argument("--list", action="store_true", help="List capture interfaces and exit")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1", help="HTTP bind address. Use 0.0.0.0 or --lan for Device B")
    parser.add_argument("--lan", action="store_true", help="Bind on all interfaces so the other PC can poll this bridge")
    parser.add_argument("--token", default=None, help="Optional shared token required by /snapshot")
    parser.add_argument(
        "--output",
        default=str(Path.home() / "WiresharkCaptures" / "ipa_capture.pcapng"),
    )
    parser.add_argument(
        "--geo-db",
        default=None,
        help="Optional local MaxMind GeoLite2-City.mmdb database for coarse public-IP geolocation",
    )
    parser.add_argument(
        "--authorized-devices",
        default=None,
        help="Optional JSON file mapping explicitly authorized test-device IPs to labels",
    )
    args = parser.parse_args()
    PORT = args.port
    AUTH_TOKEN = args.token or None
    HOST = "0.0.0.0" if args.lan else args.bind

    if args.list:
        print(list_interfaces())
        return

    if not args.interface:
        raise SystemExit("Choose an interface first. Run: python wireshark_bridge.py --list")

    capture_path = Path(args.output).expanduser().resolve()

    init_geoip(args.geo_db)
    load_authorized_devices(args.authorized_devices)

    server = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True

    worker = threading.Thread(
        target=capture_worker,
        args=(args.interface, capture_path),
        daemon=True,
    )
    worker.start()

    lan = guessed_lan_ip()
    print(f"IPA Wireshark bridge: http://{HOST}:{PORT}")
    if HOST in {"0.0.0.0", ""}:
        print(f"Device B URL: http://{lan}:{PORT}")
        print("On Device A, set that URL in Internet Protocol Assessment → Device B bridge URL.")
    print(f"Interface: {args.interface}")
    print(f"PCAPNG:    {capture_path}")
    print(f"GeoIP:     {geo_db_path or 'disabled (use --geo-db GeoLite2-City.mmdb)'}")
    print(f"Token:     {'set' if AUTH_TOKEN else 'disabled'}")
    print("Keep this window open, then open the overlay in Discord.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        if tshark_process and tshark_process.poll() is None:
            tshark_process.terminate()
            try:
                tshark_process.wait(timeout=3)
            except Exception:
                tshark_process.kill()
        server.shutdown()


if __name__ == "__main__":
    main()
