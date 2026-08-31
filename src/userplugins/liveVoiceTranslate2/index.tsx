/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Delexo } from "../_delexo/author";
import { isJunkTranscript, languagePairLabel } from "../_delexo/langNames";
import * as Ultra from "../_delexo/ultraVoiceOverlay";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React, Text, useState } from "@webpack/common";

import * as Engine from "./engine";
import managedStyle from "./style.css?managed";

const ULTRA_OWNER = "api";

const MIN_W = 180;
const MIN_H = 96;
const COMPACT_W = 280;
const COMPACT_H = 210;

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

function EyeGlyph({ off }: { off: boolean; }) {
    return off ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
    ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    );
}

function ApiKeyField() {
    const [show, setShow] = useState(false);
    const [value, setValue] = useState(() => String(settings.store.openaiApiKey || ""));

    function onChange(event: React.ChangeEvent<HTMLInputElement>) {
        const next = event.target.value;
        setValue(next);
        settings.store.openaiApiKey = next;
        Engine.setApiKey(next.trim());
    }

    return (
        <div className="spyt-live-key">
            <Text className="spyt-live-key-title" variant="text-md/medium">OpenRouter API key</Text>
            <Text className="spyt-live-key-desc" variant="text-sm/normal">Paste your OpenRouter key here. It stays hidden until you tap the eye.</Text>
            <div className="spyt-live-key-row">
                <input
                    className="spyt-live-key-input"
                    type={show ? "text" : "password"}
                    value={value}
                    onChange={onChange}
                    placeholder="sk-or-v1-..."
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    name="openrouter-api-key"
                />
                <button
                    className="spyt-live-key-eye"
                    type="button"
                    aria-label={show ? "Hide API key" : "Show API key"}
                    aria-pressed={show}
                    onClick={() => setShow(on => !on)}
                >
                    <EyeGlyph off={show} />
                </button>
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    apiKeyField: {
        type: OptionType.COMPONENT,
        component: ApiKeyField
    },
    openaiApiKey: {
        type: OptionType.STRING,
        displayName: "OpenRouter API key",
        description: "Paste your OpenRouter key here.",
        placeholder: "sk-or-v1-...",
        default: "",
        hidden: true,
        onChange(v: string) {
            Engine.setApiKey(String(v || "").trim());
        }
    },
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
            else void unmount();
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
    openaiModel: {
        type: OptionType.SELECT,
        description: "OpenRouter speech model",
        options: [
            { label: "openai/gpt-4o-transcribe (more accurate)", value: "openai/gpt-4o-transcribe", default: true },
            { label: "openai/whisper-1 (cheaper)", value: "openai/whisper-1" }
        ]
    },
    advancedOpen: {
        type: OptionType.BOOLEAN,
        description: "Keep the Advanced source picker open",
        default: false
    },
    ultraVoiceOverlay: {
        type: OptionType.BOOLEAN,
        description: "Pin translated captions next to everyone who is speaking, not just one person",
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
let stopInFlight = false;
let listenSession = 0;
let overlayAc: AbortController | null = null;
let specIdle = false;
const expandedKeys = new Set<string>();

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
    const fromSettings = (settings.store.openaiApiKey || "").trim();
    if (fromSettings) Engine.setApiKey(fromSettings);
    Engine.setModel(String(settings.store.openaiModel || "openai/gpt-4o-transcribe"));
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
    if (settings.store.overlayWidth <= 180 || settings.store.overlayHeight <= 140) {
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
    root.id = "spyt-live2-root";
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
                        <strong>Live Translate (API)</strong>
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
                        <button class="spyt-src-btn spyt-ultra-btn${settings.store.ultraVoiceOverlay ? " is-on" : ""}" type="button" data-act="ultra">Ultra overlay</button>
                    </div>
                    <p class="spyt-adv-hint" data-src-hint>${sourceHint(source)}</p>
                </div>
            </div>
            <div class="spyt-caption">
                <div class="spyt-live-feed"></div>
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
    renderFeed(Engine.getSnapshot(), false, false);
    Ultra.setUltraEnabled(ULTRA_OWNER, settings.store.ultraVoiceOverlay);
    poll();
    void Engine.loadApiKeyFromEnv().then(key => {
        if (key) setStatus("OpenRouter ready");
        else setStatus("Add OpenRouter key in plugin settings");
        if (settings.store.autoListen && key) void startListen();
    });
}

function startUiLoop() {
    if (timer != null) return;
    poll();
    timer = window.setInterval(poll, 400);
}

function stopUiLoop() {
    if (timer != null) window.clearInterval(timer);
    timer = null;
}

async function unmount() {
    stopUiLoop();
    overlayAc?.abort();
    overlayAc = null;
    window.removeEventListener("pointerdown", onDocPointer);
    closeDropdowns();
    expandedKeys.clear();
    await Engine.stopListening();
    await Engine.savePersistedHistoryNow();
    Ultra.disposeUltra(ULTRA_OWNER);
    root?.remove();
    root = null;
    lastPaint = "";
    lastStatus = "";
    optimisticListen = null;
    startInFlight = false;
    stopInFlight = false;
    listenSession++;
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
        const plus = t?.closest?.(".spyt-line-plus") as HTMLButtonElement | null;
        if (plus && el.contains(plus)) {
            e.stopPropagation();
            if (e.button !== 0 && e.pointerType === "mouse") return;
            e.preventDefault();
            toggleLineOpen(plus);
            return;
        }
        const srcBtn = t?.closest?.(".spyt-src-btn") as HTMLButtonElement | null;
        if (srcBtn && el.contains(srcBtn)) {
            e.stopPropagation();
            if (e.button !== 0 && e.pointerType === "mouse") return;
            e.preventDefault();
            if (srcBtn.dataset.act === "ultra") toggleUltra();
            else void applyAudioSource(Engine.parseAudioSource(srcBtn.dataset.src || ""));
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
            if (t?.closest?.(".spyt-live-bar, .spyt-live-resize, .spyt-live-btn, .spyt-adv, .spyt-line-plus")) return;
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

function paintUltraButton() {
    if (!root) return;
    root.querySelectorAll("[data-act='ultra']").forEach(btn => {
        btn.classList.toggle("is-on", settings.store.ultraVoiceOverlay);
    });
}

function toggleUltra() {
    settings.store.ultraVoiceOverlay = !settings.store.ultraVoiceOverlay;
    paintUltraButton();
    const listening = Boolean(optimisticListen) || Engine.isListening();
    syncUltra(Engine.getSnapshot(), listening);
    if (settings.store.ultraVoiceOverlay) setStatus("Ultra overlay on");
    else setStatus("Ultra overlay off");
}

function syncUltra(data: Engine.EngineSnapshot, listening: boolean) {
    const on = Boolean(settings.store.ultraVoiceOverlay);
    Ultra.setUltraEnabled(ULTRA_OWNER, on);
    Ultra.setUltraListening(ULTRA_OWNER, on && listening);
    const rows = historyRows(data);
    const latest = rows[rows.length - 1];
    const text = data.partial
        ? (data.original || latest?.original || latest?.translation || "").trim()
        : (latest?.translation || latest?.original || data.translation || data.original || "").trim();
    const original = (latest?.original || data.original || "").trim();
    Ultra.setUltraCaption(ULTRA_OWNER, on && listening && text ? {
        text,
        original,
        partial: data.partial,
        fromLang: latest?.fromLang,
        toLang: latest?.toLang || data.target
    } : null);
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
        if (optimisticListen === false || stopInFlight) {
            paintStopped();
            return;
        }
        await Engine.startListening();
        if (optimisticListen === false || stopInFlight) {
            await Engine.stopListening();
            paintStopped();
            return;
        }
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

function flashAct(act: string, status: string) {
    if (!root) return;
    const btn = root.querySelector(`[data-act="${act}"]`) as HTMLButtonElement | null;
    if (btn) {
        btn.classList.remove("is-hit");
        void btn.offsetWidth;
        btn.classList.add("is-hit");
        window.setTimeout(() => btn.classList.remove("is-hit"), 280);
    }
    setStatus(status);
}

function hideToggle() {
    if (!root) return;
    closeDropdowns();
    const collapsed = !root.classList.contains("spyt-live-min");
    root.classList.toggle("spyt-live-min", collapsed);
    settings.store.collapsed = collapsed;
    const btn = root.querySelector('[data-act="hide"]') as HTMLButtonElement;
    if (btn) btn.textContent = collapsed ? "Show" : "Hide";
    flashAct("hide", collapsed ? "Hidden" : "Shown");
}

function clearNow() {
    if (!root) return;
    expandedKeys.clear();
    Engine.clearHistory();
    lastPaint = "cleared";
    root.classList.remove("spyt-has-text", "spyt-has-feed");
    renderFeed(Engine.getSnapshot(), false, false);
    flashAct("clear", "Cleared");
}

function setListenLook(on: boolean, label: string) {
    if (!root) return;
    root.classList.toggle("spyt-on", on);
    const btn = root.querySelector('[data-act="listen"]') as HTMLButtonElement;
    btn.textContent = label;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
}

function hasApiKey() {
    return Engine.hasApiKey() || Boolean((settings.store.openaiApiKey || "").trim());
}

function requireApiKey() {
    if (hasApiKey()) return true;
    setStatus("Add OpenRouter key in plugin settings");
    return false;
}

function paintStopped() {
    stopUiLoop();
    setListenLook(false, "Listen");
    setStatus("Stopped");
    lastPaint = "";
    const data = Engine.getSnapshot();
    renderFeed(data, false, false);
    syncUltra(data, false);
    paintSpectrum(0, false);
    root?.classList.remove("spyt-on", "spyt-hear", "spyt-idle");
}

async function startListen() {
    if (startInFlight || stopInFlight || Engine.isListening()) return;
    syncEngineLangs();
    await Engine.loadApiKeyFromEnv();
    if (!requireApiKey()) return;
    const session = ++listenSession;
    startInFlight = true;
    optimisticListen = true;
    settings.store.autoListen = true;
    setListenLook(true, "Stop");
    setStatus("Starting…");
    try {
        await Engine.startListening();
        if (session !== listenSession) {
            if (Engine.isListening()) await Engine.stopListening();
            return;
        }
        setListenLook(true, "Stop");
        startUiLoop();
    } catch (e) {
        if (session !== listenSession) return;
        optimisticListen = false;
        settings.store.autoListen = false;
        paintStopped();
        setStatus(String(e).replace(/^Error:\s*/, "").slice(0, 100));
    } finally {
        if (session === listenSession) startInFlight = false;
    }
}

async function stopListen() {
    if (stopInFlight && optimisticListen === false) return;
    stopInFlight = true;
    listenSession++;
    startInFlight = false;
    optimisticListen = false;
    settings.store.autoListen = false;
    setListenLook(false, "Listen");
    startUiLoop();
    try {
        await Engine.stopListening();
    } finally {
        stopInFlight = false;
        paintStopped();
    }
}

function listenToggle() {
    const on = stopInFlight || startInFlight || optimisticListen === true || Engine.isListening();
    flashAct("listen", on ? "Stopping…" : "Starting…");
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

function rowKey(row: Engine.HistoryRow) {
    return `${row.original}\n${row.translation}\n${row.fromLang || ""}\n${row.toLang || ""}`;
}

function toggleLineOpen(plus: HTMLButtonElement) {
    const line = plus.closest(".spyt-line") as HTMLElement | null;
    if (!line) return;
    const key = line.dataset.key || "";
    const orig = line.querySelector(".spyt-line-orig") as HTMLElement | null;
    const open = !line.classList.contains("is-open");
    line.classList.toggle("is-open", open);
    plus.textContent = open ? "−" : "+";
    plus.setAttribute("aria-expanded", open ? "true" : "false");
    plus.setAttribute("aria-label", open ? "Hide original" : "Show original");
    if (orig) orig.hidden = !open;
    if (key) {
        if (open) expandedKeys.add(key);
        else expandedKeys.delete(key);
    }
}

function historyRows(data: Engine.EngineSnapshot): Engine.HistoryRow[] {
    const rows = data.history.filter(row => {
        const original = (row.original || "").trim();
        const translation = (row.translation || "").trim();
        if (!original && !translation) return false;
        if (original && isJunkTranscript(original)) return false;
        if (translation && isJunkTranscript(translation)) return false;
        return true;
    });
    if (!rows.length && (data.original || data.translation))
        rows.push({
            original: data.original,
            translation: data.translation || data.original,
            fromLang: data.detect === "auto" ? undefined : data.detect,
            toLang: data.target
        });
    return rows.slice(-40);
}

function emptyCaption(listening: boolean, hearing: boolean, partial: boolean) {
    if (partial) return "Transcribing…";
    if (listening && hearing) return "Hearing…";
    if (listening) return "Listening…";
    if (!hasApiKey()) return "Add OpenRouter key in plugin settings";
    return "Press Listen";
}

function renderFeed(data: Engine.EngineSnapshot, listening: boolean, hearing: boolean) {
    if (!root) return;
    const feed = root.querySelector(".spyt-live-feed") as HTMLElement | null;
    if (!feed) return;
    const rows = historyRows(data);
    root.classList.toggle("spyt-has-feed", rows.length > 0);
    root.classList.toggle("spyt-has-text", rows.length > 0);

    if (!rows.length) {
        feed.classList.add("is-empty");
        feed.replaceChildren();
        const empty = document.createElement("div");
        empty.className = "spyt-line is-empty";
        empty.textContent = emptyCaption(listening, hearing, data.partial);
        feed.appendChild(empty);
        return;
    }

    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 28;
    feed.classList.remove("is-empty");
    const last = rows.length - 1;
    feed.replaceChildren(...rows.map((row, i) => {
        const key = rowKey(row);
        const spoken = (row.original || "").trim();
        const translated = (row.translation || row.original || "").trim();
        const open = expandedKeys.has(key);
        const el = document.createElement("div");
        el.className = `spyt-line${i === last && data.partial ? " is-live" : ""}${open ? " is-open" : ""}`;
        el.dataset.key = key;

        const main = document.createElement("div");
        main.className = "spyt-line-main";

        if (spoken) {
            const plus = document.createElement("button");
            plus.className = "spyt-line-plus";
            plus.type = "button";
            plus.textContent = open ? "−" : "+";
            plus.setAttribute("aria-expanded", open ? "true" : "false");
            plus.setAttribute("aria-label", open ? "Hide original" : "Show original");
            main.appendChild(plus);
        }

        const text = document.createElement("span");
        text.className = "spyt-line-text";
        text.textContent = translated;
        main.appendChild(text);
        el.appendChild(main);

        if (spoken) {
            const extra = document.createElement("div");
            extra.className = "spyt-line-orig";
            extra.hidden = !open;
            const kicker = document.createElement("span");
            kicker.className = "spyt-orig-kicker";
            kicker.textContent = languagePairLabel(row.fromLang, row.toLang || settings.store.toLang, spoken, translated);
            const body = document.createElement("span");
            body.className = "spyt-orig-text";
            body.textContent = spoken;
            extra.append(kicker, body);
            el.appendChild(extra);
        }
        return el;
    }));
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function poll() {
    if (!root) return;
    const data = Engine.getSnapshot();
    const listening = optimisticListen === false ? false : data.listening || optimisticListen === true;
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
    syncUltra(data, listening);

    const rows = historyRows(data);
    const latest = rows[rows.length - 1];
    const paint = `${listening}|${hearing}|${data.partial}|${rows.length}|${latest?.original ?? ""}|${latest?.translation ?? ""}|${data.original}|${data.translation}`;
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
    name: "LiveVoiceTranslate (API)",
    description: "Live translation with an OpenRouter API key. Paste the key in this plugin’s settings.",
    tags: ["Voice", "Utility"],
    searchTerms: ["translate", "speech", "caption", "openai", "tagalog", "delexo"],
    authors: [Delexo],
    settings,
    managedStyle,
    async start() {
        await Engine.loadPersistedHistory();
        if (settings.store.showOverlay) mount();
    },
    async stop() {
        await unmount();
    }
});
