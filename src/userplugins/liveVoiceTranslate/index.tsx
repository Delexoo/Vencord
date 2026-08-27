/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Delexo } from "../_delexo/author";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

import * as Engine from "./engine";
import managedStyle from "./style.css?managed";

const MIN_W = 220;
const MIN_H = 118;
const COMPACT_W = 292;
const COMPACT_H = 176;

const FROM_LANGS: [string, string][] = [
    ["tl", "Tagalog"],
    ["auto", "Auto"],
    ["en", "English"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["de", "German"],
    ["zh", "Chinese"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
    ["id", "Indonesian"],
];

const TO_LANGS: [string, string][] = [
    ["en", "English"],
    ["tl", "Tagalog"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["de", "German"],
    ["zh", "Chinese"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
];

const settings = definePluginSettings({
    showOriginal: {
        type: OptionType.BOOLEAN,
        description: "Show the heard/original line as well as the translation",
        default: true
    },
    autoListen: {
        type: OptionType.BOOLEAN,
        description: "Keep listening after Listen is pressed",
        default: false
    },
    fromLang: {
        type: OptionType.STRING,
        description: "Source language (From)",
        default: "tl"
    },
    toLang: {
        type: OptionType.STRING,
        description: "Target language (To)",
        default: "en"
    },
    overlayWidth: {
        type: OptionType.NUMBER,
        description: "Overlay width",
        default: COMPACT_W
    },
    overlayHeight: {
        type: OptionType.NUMBER,
        description: "Overlay height",
        default: COMPACT_H
    },
    overlayX: {
        type: OptionType.NUMBER,
        description: "Overlay X position",
        default: -1
    },
    overlayY: {
        type: OptionType.NUMBER,
        description: "Overlay Y position",
        default: -1
    },
    collapsed: {
        type: OptionType.BOOLEAN,
        description: "Keep the overlay collapsed",
        default: false
    }
});

let root: HTMLDivElement | null = null;
let timer: number | null = null;
let lastPaint = "";
let lastStatus = "";
let optimisticListen: boolean | null = null;
let startInFlight = false;

function optionsHtml(list: [string, string][], selected: string) {
    return list.map(([code, name]) =>
        `<button class="spyt-dd-item${code === selected ? " is-on" : ""}" type="button" data-code="${code}">${name}</button>`
    ).join("");
}

function langName(list: [string, string][], code: string) {
    return list.find(([c]) => c === code)?.[1] || code;
}

function dropdownHtml(which: "from" | "to", list: [string, string][], selected: string, label: string) {
    return `
        <div class="spyt-dd" data-dd="${which}">
            <button class="spyt-dd-btn" type="button" data-act="${which}-open" aria-haspopup="listbox">
                <span class="spyt-dd-kicker">${label}</span>
                <span class="spyt-dd-value" data-dd-value="${which}">${langName(list, selected)}</span>
                <span class="spyt-dd-caret" aria-hidden="true"></span>
            </button>
            <div class="spyt-dd-menu" data-dd-menu="${which}" role="listbox" hidden>
                ${optionsHtml(list, selected)}
            </div>
        </div>`;
}

function syncEngineLangs() {
    Engine.setLanguages(settings.store.fromLang, settings.store.toLang);
}

function mount() {
    if (root) return;
    if (
        settings.store.overlayWidth < COMPACT_W - 24
        || settings.store.overlayWidth > COMPACT_W + 40
        || settings.store.overlayHeight > COMPACT_H + 30
    ) {
        settings.store.overlayWidth = COMPACT_W;
        settings.store.overlayHeight = COMPACT_H;
    }

    syncEngineLangs();

    root = document.createElement("div");
    root.id = "spyt-live-root";
    applySize(settings.store.overlayWidth, settings.store.overlayHeight);
    if (settings.store.collapsed) root.classList.add("spyt-live-min");
    root.innerHTML = `
        <div class="spyt-live-card">
            <div class="spyt-live-bar">
                <div class="spyt-live-drag" title="Drag to move">
                    <span class="spyt-live-grip" aria-hidden="true"></span>
                    <span class="spyt-live-dot"></span>
                    <div class="spyt-live-titles">
                        <strong>Live Translate</strong>
                        <span class="spyt-live-status">Ready</span>
                    </div>
                </div>
                <div class="spyt-live-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
                <div class="spyt-live-actions">
                    <button class="spyt-live-btn" type="button" data-act="listen">Listen</button>
                    <button class="spyt-live-btn" type="button" data-act="clear">Clear</button>
                    <button class="spyt-live-btn spyt-live-hide" type="button" data-act="hide">${settings.store.collapsed ? "Show" : "Hide"}</button>
                </div>
            </div>
            <div class="spyt-live-langs">
                ${dropdownHtml("from", FROM_LANGS, settings.store.fromLang, "From")}
                <span class="spyt-live-arrow" aria-hidden="true"></span>
                ${dropdownHtml("to", TO_LANGS, settings.store.toLang, "To")}
            </div>
            <div class="spyt-live-body-wrap">
                <div class="spyt-live-feed"></div>
            </div>
            <div class="spyt-live-resize" title="Drag to resize"></div>
        </div>
    `;
    document.body.appendChild(root);
    applyPosition(settings.store.overlayX, settings.store.overlayY);
    wireOverlay(root);
    wireDropdowns(root);
    makeDraggable(root.querySelector(".spyt-live-bar") as HTMLElement, root);
    makeResizable(root.querySelector(".spyt-live-resize") as HTMLElement, root);
    renderFeed(Engine.getSnapshot(), false, false);
    poll();
    timer = window.setInterval(poll, 180);

    if (settings.store.autoListen)
        void startListen();
}

function unmount() {
    if (timer != null) window.clearInterval(timer);
    timer = null;
    window.removeEventListener("pointerdown", onDocPointer);
    closeDropdowns();
    void Engine.stopListening();
    root?.remove();
    root = null;
    lastPaint = "";
    lastStatus = "";
    optimisticListen = null;
    startInFlight = false;
}

function closeDropdowns() {
    if (!root) return;
    root.querySelectorAll(".spyt-dd").forEach(dd => dd.classList.remove("is-open"));
    root.querySelectorAll(".spyt-dd-menu").forEach(menu => menu.setAttribute("hidden", ""));
}

function setDropdownValue(which: "from" | "to", code: string) {
    if (!root) return;
    const list = which === "from" ? FROM_LANGS : TO_LANGS;
    if (!list.some(([c]) => c === code)) return;
    if (which === "from") settings.store.fromLang = code;
    else settings.store.toLang = code;
    syncEngineLangs();
    const value = root.querySelector(`[data-dd-value="${which}"]`);
    if (value) value.textContent = langName(list, code);
    root.querySelectorAll(`[data-dd-menu="${which}"] .spyt-dd-item`).forEach(item => {
        item.classList.toggle("is-on", (item as HTMLElement).dataset.code === code);
    });
}

function onDocPointer(e: PointerEvent) {
    if (!root) return;
    const t = e.target as Node | null;
    if (t && root.contains(t) && (t as HTMLElement).closest?.(".spyt-dd")) return;
    closeDropdowns();
}

function wireDropdowns(el: HTMLElement) {
    el.addEventListener("pointerdown", e => {
        const t = e.target as HTMLElement | null;
        const item = t?.closest?.(".spyt-dd-item") as HTMLButtonElement | null;
        if (item) {
            e.preventDefault();
            e.stopPropagation();
            const wrap = item.closest(".spyt-dd") as HTMLElement;
            const which = wrap?.dataset.dd as "from" | "to";
            const code = item.dataset.code || "";
            if (which && code) {
                setDropdownValue(which, code);
                setStatus(`${which === "from" ? "From" : "To"} ${item.textContent || code}`);
            }
            closeDropdowns();
            return;
        }
        const btn = t?.closest?.(".spyt-dd-btn") as HTMLButtonElement | null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const wrap = btn.closest(".spyt-dd") as HTMLElement;
        const menu = wrap.querySelector(".spyt-dd-menu") as HTMLElement;
        const wasOpen = wrap.classList.contains("is-open");
        closeDropdowns();
        if (!wasOpen) {
            wrap.classList.add("is-open");
            menu.removeAttribute("hidden");
        }
    }, true);
    window.addEventListener("pointerdown", onDocPointer);
}

function wireOverlay(el: HTMLElement) {
    const onPointer = (e: PointerEvent) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest?.(".spyt-dd")) {
            e.stopPropagation();
            return;
        }
        if (t?.closest?.(".spyt-live-resize")) return;
        const btn = t?.closest?.(".spyt-live-btn") as HTMLButtonElement | null;
        if (btn && el.contains(btn)) {
            e.stopPropagation();
            if (e.button !== 0 && e.pointerType === "mouse") return;
            e.preventDefault();
            const act = btn.dataset.act;
            if (act === "hide") hideToggle();
            else if (act === "clear") clearNow();
            else if (act === "listen") listenToggle();
            return;
        }
        if (t?.closest?.(".spyt-live-bar")) return;
        e.stopPropagation();
    };
    el.addEventListener("pointerdown", onPointer, true);
    for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
        el.addEventListener(type, e => {
            const t = e.target as HTMLElement | null;
            if (t?.closest?.(".spyt-dd")) {
                e.stopPropagation();
                return;
            }
            if (t?.closest?.(".spyt-live-bar, .spyt-live-resize, .spyt-live-btn")) return;
            e.stopPropagation();
            if (type === "click" || type === "dblclick") e.preventDefault();
        }, true);
    }
}

function hideToggle() {
    if (!root) return;
    closeDropdowns();
    const collapsed = !root.classList.contains("spyt-live-min");
    root.classList.toggle("spyt-live-min", collapsed);
    settings.store.collapsed = collapsed;
    const btn = root.querySelector('[data-act="hide"]') as HTMLButtonElement;
    if (btn) btn.textContent = collapsed ? "Show" : "Hide";
}

function clearNow() {
    if (!root) return;
    Engine.clearHistory();
    lastPaint = "cleared";
    const feed = root.querySelector(".spyt-live-feed") as HTMLElement;
    feed.innerHTML = `<div class="spyt-live-empty">Cleared</div>`;
}

function setListenLook(on: boolean, label: string) {
    if (!root) return;
    root.classList.toggle("spyt-on", on);
    const btn = root.querySelector('[data-act="listen"]') as HTMLButtonElement;
    btn.textContent = label;
}

async function startListen() {
    if (startInFlight || Engine.isListening()) return;
    startInFlight = true;
    optimisticListen = true;
    settings.store.autoListen = true;
    syncEngineLangs();
    setListenLook(true, "Start");
    setStatus("Loading model…");
    try {
        await Engine.startListening();
        setListenLook(true, "Stop");
        setStatus("Listening");
    } catch (e) {
        optimisticListen = false;
        settings.store.autoListen = false;
        setListenLook(false, "Listen");
        setStatus(String(e).replace(/^Error:\s*/, "").slice(0, 100));
    } finally {
        startInFlight = false;
    }
}

async function stopListen() {
    optimisticListen = false;
    settings.store.autoListen = false;
    setListenLook(false, "Listen");
    setStatus("Stopped");
    await Engine.stopListening();
}

function listenToggle() {
    const on = optimisticListen ?? Engine.isListening() ?? settings.store.autoListen;
    if (on) void stopListen();
    else void startListen();
}

function applySize(width: number, height: number) {
    if (!root) return;
    const w = Math.max(MIN_W, Math.min(window.innerWidth - 16, Math.round(width)));
    const h = Math.max(MIN_H, Math.min(window.innerHeight - 16, Math.round(height)));
    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
}

function applyPosition(x: number, y: number) {
    if (!root) return;
    if (x < 0 || y < 0) return;
    const maxX = Math.max(0, window.innerWidth - (root.offsetWidth || MIN_W));
    const maxY = Math.max(0, window.innerHeight - (root.offsetHeight || MIN_H));
    root.style.left = `${Math.min(maxX, Math.max(0, Math.round(x)))}px`;
    root.style.top = `${Math.min(maxY, Math.max(0, Math.round(y)))}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
}

function setStatus(text: string) {
    if (!root || text === lastStatus) return;
    lastStatus = text;
    (root.querySelector(".spyt-live-status") as HTMLElement).textContent = text;
}

function historyRows(data: Engine.EngineSnapshot): Engine.HistoryRow[] {
    const rows = data.history.filter(row => row.original || row.translation);
    if (!rows.length && (data.original || data.translation))
        rows.push({ original: data.original, translation: data.translation || data.original });
    return rows.slice(-12);
}

function renderFeed(data: Engine.EngineSnapshot, listening: boolean, hearing: boolean) {
    if (!root) return;
    const feed = root.querySelector(".spyt-live-feed") as HTMLElement;
    const rows = historyRows(data);

    if (!rows.length) {
        const idle = listening && !hearing;
        feed.innerHTML = idle
            ? `<div class="spyt-live-empty spyt-live-idle">
                <span class="spyt-idle-waves" aria-hidden="true"><i></i><i></i><i></i></span>
                <span>Listening…</span>
               </div>`
            : `<div class="spyt-live-empty">${
                listening ? "Hearing… words will appear soon" : "Press Listen"
            }</div>`;
        return;
    }
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 36;
    feed.replaceChildren(...rows.map((row, i) => {
        const el = document.createElement("div");
        el.className = "spyt-line" + (data.partial && i === rows.length - 1 ? " spyt-live" : "");
        const en = document.createElement("span");
        en.className = "spyt-line-en";
        en.textContent = row.translation || row.original || "";
        el.appendChild(en);
        if (settings.store.showOriginal) {
            const orig = (row.original || "").trim();
            const shown = (row.translation || "").trim();
            if (orig && orig.toLowerCase() !== shown.toLowerCase()) {
                const tip = document.createElement("span");
                tip.className = "spyt-tip";
                tip.textContent = orig;
                el.appendChild(tip);
            }
        }
        return el;
    }));
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function poll() {
    if (!root) return;
    const data = Engine.getSnapshot();
    const listening = data.listening || Boolean(optimisticListen);
    const hearing = Number(data.level || 0) >= 0.01;

    if (!startInFlight) {
        root.classList.toggle("spyt-on", listening);
        const btn = root.querySelector('[data-act="listen"]') as HTMLButtonElement;
        if (btn && document.activeElement !== btn)
            btn.textContent = listening ? "Stop" : "Listen";
    }
    root.classList.toggle("spyt-hear", listening && hearing);
    root.classList.toggle("spyt-idle", listening && !hearing);

    if (data.status) setStatus(data.status);

    const rows = historyRows(data);
    const paint = JSON.stringify({
        rows, listening, hearing,
        partial: data.partial,
        detect: data.detect,
        target: data.target
    });
    if (paint === lastPaint) return;
    lastPaint = paint;
    renderFeed(data, listening, hearing);
}

function makeDraggable(handle: HTMLElement, box: HTMLElement) {
    let sx = 0, sy = 0, ox = 0, oy = 0, down = false, pid = -1, moved = false;
    const endDrag = (e: PointerEvent) => {
        if (!down || (pid >= 0 && e.pointerId !== pid)) return;
        down = false;
        pid = -1;
        box.classList.remove("spyt-live-dragging");
        handle.classList.remove("spyt-live-dragging");
        try {
            if (box.hasPointerCapture(e.pointerId))
                box.releasePointerCapture(e.pointerId);
        } catch { /* ignore */ }
        if (moved) {
            const rect = box.getBoundingClientRect();
            settings.store.overlayX = Math.round(rect.left);
            settings.store.overlayY = Math.round(rect.top);
        }
    };
    handle.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        const t = e.target as HTMLElement;
        if (t.closest(".spyt-live-btn, .spyt-dd, .spyt-live-resize")) return;
        down = true;
        moved = false;
        pid = e.pointerId;
        sx = e.clientX;
        sy = e.clientY;
        const rect = box.getBoundingClientRect();
        ox = rect.left;
        oy = rect.top;
        try { box.setPointerCapture(pid); } catch { /* ignore */ }
        box.classList.add("spyt-live-dragging");
        handle.classList.add("spyt-live-dragging");
        e.preventDefault();
        e.stopPropagation();
    }, true);
    box.addEventListener("pointermove", e => {
        if (!down || e.pointerId !== pid) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        moved = true;
        const maxX = Math.max(0, window.innerWidth - box.offsetWidth);
        const maxY = Math.max(0, window.innerHeight - box.offsetHeight);
        box.style.left = `${Math.min(maxX, Math.max(0, ox + dx))}px`;
        box.style.top = `${Math.min(maxY, Math.max(0, oy + dy))}px`;
        box.style.right = "auto";
        box.style.bottom = "auto";
        e.preventDefault();
        e.stopPropagation();
    });
    box.addEventListener("pointerup", endDrag);
    box.addEventListener("pointercancel", endDrag);
}

function makeResizable(handle: HTMLElement, box: HTMLElement) {
    let sx = 0, sy = 0, sw = 0, sh = 0, down = false;
    handle.addEventListener("pointerdown", e => {
        down = true;
        sx = e.clientX;
        sy = e.clientY;
        sw = box.getBoundingClientRect().width;
        sh = box.getBoundingClientRect().height;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    window.addEventListener("pointerup", () => {
        if (!down || !root) {
            down = false;
            return;
        }
        down = false;
        settings.store.overlayWidth = Math.round(root.getBoundingClientRect().width);
        settings.store.overlayHeight = Math.round(root.getBoundingClientRect().height);
    });
    window.addEventListener("pointermove", e => {
        if (!down) return;
        applySize(sw + e.clientX - sx, sh + e.clientY - sy);
    });
}

export default definePlugin({
    name: "LiveVoiceTranslate",
    description: "Standalone live Discord voice translation overlay. No SpyT, port, or run.bat.",
    tags: ["Voice", "Utility"],
    searchTerms: ["translate", "speech", "caption", "whisper", "tagalog", "delexo"],
    authors: [Delexo],
    settings,
    managedStyle,
    async start() {
        await Engine.loadPersistedHistory();
        mount();
    },
    async stop() {
        await Engine.savePersistedHistoryNow();
        unmount();
    }
});
