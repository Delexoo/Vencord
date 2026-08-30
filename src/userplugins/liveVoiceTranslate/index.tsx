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

const MIN_W = 148;
const MIN_H = 92;
const COMPACT_W = 220;
const COMPACT_H = 248;

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const FROM_LANGS: [string, string][] = [
    ["auto", "Auto"],
    ["tl", "Tagalog"],
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
    showOverlay: {
        type: OptionType.BOOLEAN,
        description: "Show the Live Translate window",
        default: true,
        onChange(v: boolean) {
            if (v) mount();
            else unmount();
        }
    },
    fromLang: {
        type: OptionType.STRING,
        description: "Source language (From)",
        default: "auto"
    },
    toLang: {
        type: OptionType.STRING,
        description: "Target language (To)",
        default: "en"
    },
    audioSource: {
        type: OptionType.STRING,
        description: "What to listen to: discord, system, or mic",
        default: "discord"
    },
    advancedOpen: {
        type: OptionType.BOOLEAN,
        description: "Keep the Advanced source picker open",
        default: false
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
let overlayAc: AbortController | null = null;
let specIdle = false;

function parseResizeEdge(value: string | undefined): ResizeEdge | null {
    switch (value) {
        case "n":
        case "s":
        case "e":
        case "w":
        case "ne":
        case "nw":
        case "se":
        case "sw":
            return value;
        default:
            return null;
    }
}

function resizeHandlesHtml() {
    const edges: ResizeEdge[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];
    return edges.map(edge =>
        `<div class="spyt-live-resize${edge === "se" ? " spyt-live-resize-grip" : ""}" data-edge="${edge}" title="Resize"></div>`
    ).join("");
}

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

function sourceHint(source: Engine.AudioSource) {
    switch (source) {
        case "discord":
            return "This Discord window. Voice calls on Windows often need System audio.";
        case "system":
            return "All PC audio: Discord, games, browsers, and other apps.";
        case "mic":
            return "Your microphone only.";
        default: {
            const _: never = source;
            return _;
        }
    }
}

function syncEngineLangs() {
    Engine.setLanguages(settings.store.fromLang || "auto", settings.store.toLang || "en");
    Engine.setAudioSource(Engine.parseAudioSource(settings.store.audioSource));
}

function currentSource() {
    return Engine.parseAudioSource(settings.store.audioSource);
}

function paintSourceButtons() {
    if (!root) return;
    const source = currentSource();
    root.querySelectorAll(".spyt-src-btn").forEach(btn => {
        const el = btn as HTMLButtonElement;
        el.classList.toggle("is-on", el.dataset.src === source);
    });
    const hint = root.querySelector("[data-src-hint]") as HTMLElement | null;
    if (hint) hint.textContent = sourceHint(source);
}

function mount() {
    if (root) return;
    if (
        (settings.store.overlayWidth === 292 && settings.store.overlayHeight === 268)
        || (settings.store.overlayWidth === 220 && settings.store.overlayHeight === 202)
    ) {
        settings.store.overlayWidth = COMPACT_W;
        settings.store.overlayHeight = COMPACT_H;
    }
    if (!(settings.store.overlayWidth >= MIN_W))
        settings.store.overlayWidth = COMPACT_W;
    if (!(settings.store.overlayHeight >= MIN_H))
        settings.store.overlayHeight = COMPACT_H;

    overlayAc?.abort();
    const ac = new AbortController();
    overlayAc = ac;

    syncEngineLangs();

    root = document.createElement("div");
    root.id = "spyt-live-root";
    applySize(settings.store.overlayWidth, settings.store.overlayHeight);
    if (settings.store.collapsed) root.classList.add("spyt-live-min");
    if (settings.store.advancedOpen) root.classList.add("spyt-adv-open");
    const source = currentSource();
    root.innerHTML = `
        <div class="spyt-live-card">
            <div class="spyt-live-bar">
                <div class="spyt-live-drag" title="Drag to move">
                    <span class="spyt-live-grip" aria-hidden="true"></span>
                    <span class="spyt-live-dot" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                    <div class="spyt-live-titles">
                        <strong>Live Translate</strong>
                        <span class="spyt-live-status">Ready</span>
                    </div>
                </div>
                <div class="spyt-live-actions">
                    <button class="spyt-live-btn" type="button" data-act="listen">Listen</button>
                    <button class="spyt-live-btn" type="button" data-act="clear">Clear</button>
                    <button class="spyt-live-btn spyt-live-hide" type="button" data-act="hide">${settings.store.collapsed ? "Show" : "Hide"}</button>
                </div>
            </div>
            <div class="spyt-live-langs">
                ${dropdownHtml("from", FROM_LANGS, settings.store.fromLang || "auto", "From")}
                <span class="spyt-live-arrow" aria-hidden="true"></span>
                ${dropdownHtml("to", TO_LANGS, settings.store.toLang || "en", "To")}
            </div>
            <div class="spyt-adv">
                <button class="spyt-adv-toggle" type="button" data-act="adv">
                    <span>Advanced</span>
                    <span class="spyt-dd-caret" aria-hidden="true"></span>
                </button>
                <div class="spyt-adv-body">
                    <span class="spyt-adv-kicker">Listen to</span>
                    <div class="spyt-src">
                        <button class="spyt-src-btn${source === "discord" ? " is-on" : ""}" type="button" data-src="discord">Discord</button>
                        <button class="spyt-src-btn${source === "system" ? " is-on" : ""}" type="button" data-src="system">System</button>
                        <button class="spyt-src-btn${source === "mic" ? " is-on" : ""}" type="button" data-src="mic">Mic</button>
                    </div>
                    <p class="spyt-adv-hint" data-src-hint>${sourceHint(source)}</p>
                </div>
            </div>
            <div class="spyt-caption is-empty" data-act="caption">
                <span class="spyt-caption-kicker">Translation</span>
                <span class="spyt-caption-en">Press Listen — translations appear here</span>
            </div>
            <div class="spyt-live-body-wrap">
                <div class="spyt-live-feed"></div>
            </div>
            <div class="spyt-orig-float" hidden>
                <span class="spyt-orig-kicker">Spoken</span>
                <span class="spyt-orig-text"></span>
            </div>
        </div>
        ${resizeHandlesHtml()}
    `;
    document.body.appendChild(root);
    applyPosition(settings.store.overlayX, settings.store.overlayY);
    wireOverlay(root);
    wireDropdowns(root);
    paintSourceButtons();
    makeDraggable(root.querySelector(".spyt-live-bar") as HTMLElement, root);
    makeResizable(root, ac.signal);
    window.addEventListener("resize", keepOnScreen, { signal: ac.signal });
    wireSpokenHover(root);
    renderCaption(Engine.getSnapshot(), false, false);
    renderFeed(Engine.getSnapshot(), false);
    poll();

    if (settings.store.autoListen)
        void startListen();
}

function startUiLoop() {
    if (timer != null) return;
    poll();
    timer = window.setInterval(poll, 400);
}

function stopUiLoop() {
    if (timer != null) window.clearInterval(timer);
    timer = null;
    poll();
}

function unmount() {
    stopUiLoop();
    overlayAc?.abort();
    overlayAc = null;
    window.removeEventListener("pointerdown", onDocPointer);
    closeDropdowns();
    hideOrigTip();
    void Engine.stopListening();
    root?.remove();
    root = null;
    lastPaint = "";
    lastStatus = "";
    optimisticListen = null;
    startInFlight = false;
    specIdle = false;
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
        const srcBtn = t?.closest?.(".spyt-src-btn") as HTMLButtonElement | null;
        if (srcBtn && el.contains(srcBtn)) {
            e.stopPropagation();
            if (e.button !== 0 && e.pointerType === "mouse") return;
            e.preventDefault();
            void applyAudioSource(Engine.parseAudioSource(srcBtn.dataset.src || ""));
            return;
        }
        const btn = t?.closest?.(".spyt-live-btn, .spyt-adv-toggle") as HTMLButtonElement | null;
        if (btn && el.contains(btn)) {
            e.stopPropagation();
            if (e.button !== 0 && e.pointerType === "mouse") return;
            e.preventDefault();
            const act = btn.dataset.act;
            if (act === "hide") hideToggle();
            else if (act === "clear") clearNow();
            else if (act === "listen") listenToggle();
            else if (act === "adv") toggleAdvanced();
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
            if (t?.closest?.(".spyt-live-bar, .spyt-live-resize, .spyt-live-btn, .spyt-adv")) return;
            e.stopPropagation();
            if (type === "click" || type === "dblclick") e.preventDefault();
        }, true);
    }
}

function toggleAdvanced() {
    if (!root) return;
    const open = !root.classList.contains("spyt-adv-open");
    root.classList.toggle("spyt-adv-open", open);
    settings.store.advancedOpen = open;
}

async function applyAudioSource(source: Engine.AudioSource) {
    settings.store.audioSource = source;
    Engine.setAudioSource(source);
    paintSourceButtons();
    const wasListening = Boolean(optimisticListen) || Engine.isListening();
    if (!wasListening) return;
    setStatus("Switching source…");
    try {
        await Engine.stopListening(true);
        await Engine.startListening();
        setListenLook(true, "Stop");
        startUiLoop();
    } catch (e) {
        optimisticListen = false;
        settings.store.autoListen = false;
        setListenLook(false, "Listen");
        stopUiLoop();
        setStatus(String(e).replace(/^Error:\s*/, "").slice(0, 100));
    }
}

function hideToggle() {
    if (!root) return;
    closeDropdowns();
    hideOrigTip();
    const collapsed = !root.classList.contains("spyt-live-min");
    root.classList.toggle("spyt-live-min", collapsed);
    settings.store.collapsed = collapsed;
    const btn = root.querySelector('[data-act="hide"]') as HTMLButtonElement;
    if (btn) btn.textContent = collapsed ? "Show" : "Hide";
}

function clearNow() {
    if (!root) return;
    hideOrigTip();
    Engine.clearHistory();
    lastPaint = "cleared";
    root.classList.remove("spyt-has-text", "spyt-has-feed");
    const data = Engine.getSnapshot();
    renderCaption(data, false, false);
    renderFeed(data, false);
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
        startUiLoop();
    } catch (e) {
        optimisticListen = false;
        settings.store.autoListen = false;
        setListenLook(false, "Listen");
        stopUiLoop();
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
    stopUiLoop();
    await Engine.stopListening();
}

function listenToggle() {
    const on = optimisticListen ?? Engine.isListening() ?? settings.store.autoListen;
    if (on) void stopListen();
    else void startListen();
}

function applySize(width: number, height: number) {
    if (!root) return;
    const collapsed = root.classList.contains("spyt-live-min");
    const w = Math.max(MIN_W, Math.min(window.innerWidth - 12, Math.round(width)));
    const h = Math.max(MIN_H, Math.min(window.innerHeight - 12, Math.round(height)));
    root.style.width = `${w}px`;
    if (!collapsed) root.style.height = `${h}px`;
}

function applyPosition(x: number, y: number) {
    if (!root) return;
    if (x < 0 || y < 0) return;
    const w = root.offsetWidth || MIN_W;
    const h = root.offsetHeight || MIN_H;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    root.style.left = `${Math.min(maxX, Math.max(0, Math.round(x)))}px`;
    root.style.top = `${Math.min(maxY, Math.max(0, Math.round(y)))}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
}

function keepOnScreen() {
    if (!root) return;
    const rect = root.getBoundingClientRect();
    applySize(rect.width, rect.height);
    if (root.style.left !== "" && root.style.top !== "")
        applyPosition(rect.left, rect.top);
}

function setStatus(text: string) {
    if (!root || text === lastStatus) return;
    lastStatus = text;
    (root.querySelector(".spyt-live-status") as HTMLElement).textContent = text;
}

function paintSpectrum(level: number, live: boolean) {
    if (!root) return;
    if (!live) {
        if (specIdle) return;
        specIdle = true;
    } else {
        specIdle = false;
    }
    const v = live ? Math.min(1, level * 18) : 0;
    const bars = root.querySelectorAll(".spyt-live-dot i");
    for (let i = 0; i < bars.length; i++) {
        const wobble = live ? 0.55 + ((i % 3) * 0.15) : 0.28;
        (bars[i] as HTMLElement).style.transform = `scaleY(${live ? 0.18 + v * wobble * 0.82 : 0.28})`;
    }
}

function hideOrigTip() {
    const tip = root?.querySelector(".spyt-orig-float") as HTMLElement | null;
    if (!tip) return;
    tip.hidden = true;
    tip.classList.remove("is-on");
}

function showOrigTip(anchor: HTMLElement, spoken: string) {
    if (!root) return;
    const text = spoken.trim();
    if (!text) {
        hideOrigTip();
        return;
    }
    const tip = root.querySelector(".spyt-orig-float") as HTMLElement | null;
    const body = tip?.querySelector(".spyt-orig-text") as HTMLElement | null;
    if (!tip || !body) return;
    body.textContent = text;
    tip.hidden = false;
    tip.classList.add("is-on");

    const rootRect = root.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const gap = 6;
    let top = anchorRect.bottom - rootRect.top + gap;
    if (top + tipRect.height > rootRect.height - 8)
        top = Math.max(8, anchorRect.top - rootRect.top - tipRect.height - gap);
    let left = anchorRect.left - rootRect.left;
    left = Math.min(Math.max(8, left), Math.max(8, rootRect.width - tipRect.width - 8));
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
}

function wireSpokenHover(el: HTMLElement) {
    el.addEventListener("pointerover", e => {
        const hit = (e.target as HTMLElement | null)?.closest?.("[data-spoken]") as HTMLElement | null;
        if (!hit || !el.contains(hit) || !hit.dataset.spoken) {
            hideOrigTip();
            return;
        }
        showOrigTip(hit, hit.dataset.spoken);
    });
    el.addEventListener("pointerleave", () => hideOrigTip());
}

function historyRows(data: Engine.EngineSnapshot): Engine.HistoryRow[] {
    const rows = data.history.filter(row => row.original || row.translation);
    if (!rows.length && (data.original || data.translation))
        rows.push({ original: data.original, translation: data.translation || data.original });
    return rows.slice(-12);
}

function renderCaption(data: Engine.EngineSnapshot, listening: boolean, hearing: boolean) {
    if (!root) return;
    const cap = root.querySelector(".spyt-caption") as HTMLElement | null;
    const en = cap?.querySelector(".spyt-caption-en") as HTMLElement | null;
    if (!cap || !en) return;

    const spoken = (data.original || "").trim();
    const translated = (data.translation || data.original || "").trim();
    if (!translated) {
        cap.classList.add("is-empty");
        cap.classList.toggle("spyt-live", Boolean(data.partial || (listening && hearing)));
        delete cap.dataset.spoken;
        en.textContent = data.partial
            ? "Transcribing…"
            : listening && hearing
                ? "Hearing…"
                : listening
                    ? "Listening… speech will show up here"
                    : "Press Listen — translations appear here";
        return;
    }

    cap.classList.remove("is-empty");
    cap.classList.toggle("spyt-live", Boolean(data.partial));
    cap.dataset.spoken = spoken;
    en.textContent = translated;
}

function renderFeed(data: Engine.EngineSnapshot, listening: boolean) {
    if (!root) return;
    const feed = root.querySelector(".spyt-live-feed") as HTMLElement;
    const rows = historyRows(data);
    const older = rows.slice(0, -1);
    root.classList.toggle("spyt-has-feed", older.length > 0);

    if (!older.length) {
        feed.replaceChildren();
        return;
    }

    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 36;
    feed.replaceChildren(...older.map(row => {
        const el = document.createElement("div");
        el.className = "spyt-line";
        const spoken = (row.original || "").trim();
        if (spoken) el.dataset.spoken = spoken;
        const en = document.createElement("span");
        en.className = "spyt-line-en";
        en.textContent = (row.translation || row.original || "").trim();
        el.appendChild(en);
        return el;
    }));
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function poll() {
    if (!root) return;
    const data = Engine.getSnapshot();
    const listening = data.listening || Boolean(optimisticListen);
    const hearing = Number(data.level || 0) >= 0.002;

    if (!startInFlight) {
        root.classList.toggle("spyt-on", listening);
        const btn = root.querySelector('[data-act="listen"]') as HTMLButtonElement;
        if (btn && document.activeElement !== btn)
            btn.textContent = listening ? "Stop" : "Listen";
    }
    root.classList.toggle("spyt-hear", listening && hearing);
    root.classList.toggle("spyt-idle", listening && !hearing);
    root.classList.toggle("spyt-has-text", Boolean((data.translation || data.original || "").trim()));

    const src = Engine.getAudioSource();
    if (src !== currentSource()) {
        settings.store.audioSource = src;
        paintSourceButtons();
    }

    if (data.status) setStatus(data.status);
    paintSpectrum(data.level, listening);

    const rows = historyRows(data);
    const latest = rows[rows.length - 1];
    const paint = `${listening}|${hearing}|${data.partial}|${rows.length}|${latest?.original ?? ""}|${latest?.translation ?? ""}|${data.original}|${data.translation}`;
    if (paint === lastPaint) return;
    lastPaint = paint;
    renderCaption(data, listening, hearing);
    renderFeed(data, listening);
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
        if (t.closest(".spyt-live-btn, .spyt-dd, .spyt-live-resize, .spyt-adv")) return;
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

function makeResizable(box: HTMLElement, signal: AbortSignal) {
    let sx = 0, sy = 0, sw = 0, sh = 0, sl = 0, st = 0;
    let down = false;
    let pid = -1;
    let edge: ResizeEdge = "se";

    const endResize = (e: PointerEvent) => {
        if (!down || (pid >= 0 && e.pointerId !== pid)) return;
        down = false;
        pid = -1;
        box.classList.remove("spyt-live-resizing");
        try {
            if (box.hasPointerCapture(e.pointerId))
                box.releasePointerCapture(e.pointerId);
        } catch { /* ignore */ }
        if (!root) return;
        settings.store.overlayWidth = Math.round(root.getBoundingClientRect().width);
        if (!root.classList.contains("spyt-live-min"))
            settings.store.overlayHeight = Math.round(root.getBoundingClientRect().height);
        settings.store.overlayX = Math.round(root.getBoundingClientRect().left);
        settings.store.overlayY = Math.round(root.getBoundingClientRect().top);
    };

    box.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        const handle = (e.target as HTMLElement | null)?.closest?.(".spyt-live-resize") as HTMLElement | null;
        if (!handle || !box.contains(handle)) return;
        const next = parseResizeEdge(handle.dataset.edge);
        if (!next) return;
        down = true;
        edge = next;
        pid = e.pointerId;
        sx = e.clientX;
        sy = e.clientY;
        const rect = box.getBoundingClientRect();
        sw = rect.width;
        sh = rect.height;
        sl = rect.left;
        st = rect.top;
        box.classList.add("spyt-live-resizing");
        try { box.setPointerCapture(pid); } catch { /* ignore */ }
        e.preventDefault();
        e.stopPropagation();
    }, true);

    box.addEventListener("pointermove", e => {
        if (!down || e.pointerId !== pid) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        const maxW = window.innerWidth - 8;
        const maxH = window.innerHeight - 8;
        const right = sl + sw;
        const bottom = st + sh;
        const growE = edge === "e" || edge === "ne" || edge === "se";
        const growW = edge === "w" || edge === "nw" || edge === "sw";
        const growS = edge === "s" || edge === "se" || edge === "sw";
        const growN = edge === "n" || edge === "ne" || edge === "nw";

        let w = sw;
        let h = sh;
        let left = sl;
        let top = st;
        if (growE) w = sw + dx;
        if (growW) w = sw - dx;
        if (growS) h = sh + dy;
        if (growN) h = sh - dy;

        w = Math.max(MIN_W, Math.min(maxW, w));
        h = Math.max(MIN_H, Math.min(maxH, h));

        if (growW) {
            left = right - w;
            if (left < 0) {
                left = 0;
                w = Math.max(MIN_W, Math.min(maxW, right));
            }
        } else if (growE) {
            w = Math.max(MIN_W, Math.min(w, window.innerWidth - left - 8));
        }

        if (growN) {
            top = bottom - h;
            if (top < 0) {
                top = 0;
                h = Math.max(MIN_H, Math.min(maxH, bottom));
            }
        } else if (growS) {
            h = Math.max(MIN_H, Math.min(h, window.innerHeight - top - 8));
        }

        applySize(w, h);
        box.style.left = `${Math.round(left)}px`;
        box.style.top = `${Math.round(top)}px`;
        box.style.right = "auto";
        box.style.bottom = "auto";
        e.preventDefault();
        e.stopPropagation();
    }, { signal });

    box.addEventListener("pointerup", endResize, { signal });
    box.addEventListener("pointercancel", endResize, { signal });
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
        if (settings.store.showOverlay) mount();
    },
    async stop() {
        await Engine.savePersistedHistoryNow();
        unmount();
    }
});
