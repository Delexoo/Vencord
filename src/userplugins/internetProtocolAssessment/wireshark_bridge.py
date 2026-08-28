#!/usr/bin/env python3
"""
Local Wireshark/TShark bridge for the Vencord "Internet Protocol Assessment" plugin.

Safety properties:
- Binds ONLY to 127.0.0.1.
- Captures traffic from the local machine's selected interface.
- Uses TShark for capture; the plugin never gets raw packet bytes.
- Keeps an in-memory connection summary and a PCAPNG capture file.
- Does not decrypt traffic or attempt to intercept other hosts' traffic.

Usage:
  python wireshark_bridge.py --list
  python wireshark_bridge.py --interface 1
  python wireshark_bridge.py --interface 1 --geo-db GeoLite2-City.mmdb
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

try:
    import geoip2.database  # optional: pip install geoip2
except Exception:
    geoip2 = None

HOST = "127.0.0.1"
PORT = 8765
MAX_CONNECTIONS = 150
AUTH_TOKEN = None

state_lock = threading.Lock()
state = {
    "running": False,
    "interfaceName": "-",
    "captureFile": "-",
    "packetsCaptured": 0,
    "connections": OrderedDict(),
    "lastError": None,
    "updatedAt": "",
}

stop_event = threading.Event()
tshark_process = None
geo_reader = None
geo_db_path = None
geo_cache = {}

COMMON_TSHARK = [
    r"C:\Program Files\Wireshark\tshark.exe",
    r"C:\Program Files (x86)\Wireshark\tshark.exe",
    "/usr/bin/tshark",
    "/usr/local/bin/tshark",
    "/opt/homebrew/bin/tshark",
    "/Applications/Wireshark.app/Contents/MacOS/tshark",
]


def guessed_lan_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except Exception:
        return "THIS-PC-LAN-IP"
    finally:
        sock.close()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


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


def first_nonempty(*values: str) -> str:
    for value in values:
        if value:
            return value
    return ""


def empty_geo(scope: str = "Unknown"):
    return {
        "scope": scope,
        "city": None,
        "region": None,
        "country": None,
        "countryCode": None,
        "latitude": None,
        "longitude": None,
    }


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
    """Coarse location for a public IP. Private/LAN addresses are not geolocated."""
    if not value:
        return empty_geo()

    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return empty_geo()

    if not ip.is_global:
        return empty_geo("Private/LAN")

    cached = geo_cache.get(value)
    if cached is not None:
        return cached

    result = empty_geo("Public")
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
            pass

    geo_cache[value] = result
    return result


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


def update_connection(fields: list[str]):
    #  0 time
    #  1 application/display protocol
    #  2 ip.src
    #  3 ipv6.src
    #  4 ip.dst
    #  5 ipv6.dst
    #  6 tcp.srcport
    #  7 udp.srcport
    #  8 tcp.dstport
    #  9 udp.dstport
    # 10 icmp.type
    # 11 icmpv6.type
    # 12 frame.len
    # 13 ip.proto
    # 14 ipv6.nxt
    # 15 tcp.stream
    # 16 udp.stream
    if len(fields) < 13:
        return

    fields = fields + [""] * (17 - len(fields))
    (
        timestamp,
        app_protocol,
        ip4_src,
        ip6_src,
        ip4_dst,
        ip6_dst,
        tcp_sport,
        udp_sport,
        tcp_dport,
        udp_dport,
        icmp_type,
        icmpv6_type,
        frame_len,
        ip_proto,
        ipv6_next,
        tcp_stream,
        udp_stream,
    ) = fields[:17]

    src = first_nonempty(ip4_src, ip6_src) or "-"
    dst = first_nonempty(ip4_dst, ip6_dst) or "-"
    app_protocol = (app_protocol or "OTHER").upper()

    def as_int(value: str):
        try:
            return int(value) if value else None
        except ValueError:
            return None

    tcp_sport_i = as_int(tcp_sport)
    tcp_dport_i = as_int(tcp_dport)
    udp_sport_i = as_int(udp_sport)
    udp_dport_i = as_int(udp_dport)

    if tcp_sport_i is not None or tcp_dport_i is not None:
        transport = "TCP"
        sport_i, dport_i = tcp_sport_i, tcp_dport_i
        stream_id = tcp_stream or None
    elif udp_sport_i is not None or udp_dport_i is not None:
        transport = "UDP"
        sport_i, dport_i = udp_sport_i, udp_dport_i
        stream_id = udp_stream or None
    elif icmp_type:
        transport = "ICMP"
        sport_i = dport_i = None
        stream_id = None
    elif icmpv6_type:
        transport = "ICMPV6"
        sport_i = dport_i = None
        stream_id = None
    else:
        transport = f"IP-{ip_proto or ipv6_next}" if (ip_proto or ipv6_next) else "OTHER"
        sport_i = dport_i = None
        stream_id = None

    try:
        length_i = int(frame_len)
    except ValueError:
        length_i = 0

    key = (transport, app_protocol, src, dst, sport_i, dport_i)

    with state_lock:
        current = state["connections"].get(key)
        if current is None:
            src_geo = geo_for_ip(src)
            dst_geo = geo_for_ip(dst)
            current = {
                "transport": transport,
                "protocol": app_protocol,
                "src": src,
                "dst": dst,
                "sport": sport_i,
                "dport": dport_i,
                "streamId": stream_id,
                "packets": 0,
                "bytes": 0,
                "firstSeen": timestamp or utc_now(),
                "lastSeen": timestamp or utc_now(),
                "encrypted": "Unknown",
                "srcGeo": src_geo,
                "dstGeo": dst_geo,
                "srcLocation": geo_label(src_geo),
                "dstLocation": geo_label(dst_geo),
            }
            state["connections"][key] = current

        current["packets"] += 1
        current["bytes"] += length_i
        current["lastSeen"] = timestamp or utc_now()

        if app_protocol in {"TLS", "TLSV1.2", "TLSV1.3", "DTLS", "QUIC", "HTTPS"}:
            current["encrypted"] = "Encrypted transport"
        elif app_protocol in {"HTTP", "FTP", "TELNET"}:
            current["encrypted"] = "Plaintext protocol"
        else:
            current["encrypted"] = "Unknown"

        while len(state["connections"]) > MAX_CONNECTIONS:
            state["connections"].popitem(last=False)

        state["packetsCaptured"] += 1
        state["updatedAt"] = utc_now()


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

        # -P is required: without it, -w writes the PCAPNG and stdout stays empty.
        command = [
            tshark,
            "-i", interface,
            "-p",
            "-P",
            "-l",
            "-n",
            "-w", str(capture_file),
            "-T", "fields",
            "-E", "header=n",
            "-E", "separator=|",
            "-E", "occurrence=f",
            "-e", "frame.time_epoch",
            "-e", "_ws.col.Protocol",
            "-e", "ip.src",
            "-e", "ipv6.src",
            "-e", "ip.dst",
            "-e", "ipv6.dst",
            "-e", "tcp.srcport",
            "-e", "udp.srcport",
            "-e", "tcp.dstport",
            "-e", "udp.dstport",
            "-e", "icmp.type",
            "-e", "icmpv6.type",
            "-e", "frame.len",
            "-e", "ip.proto",
            "-e", "ipv6.nxt",
            "-e", "tcp.stream",
            "-e", "udp.stream",
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
                payload = {
                    **state,
                    "connections": list(state["connections"].values()),
                    "geoDatabase": geo_db_path or "-",
                    "geoEnabled": geo_reader is not None,
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
        help="Optional local MaxMind GeoLite2-City.mmdb for coarse public-IP geolocation",
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
