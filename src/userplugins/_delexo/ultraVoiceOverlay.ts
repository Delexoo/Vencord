/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelRTCStore, ChannelStore, GuildMemberStore, MediaEngineStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { languagePairLabel } from "./langNames";

const LAYER_ID = "spyt-ultra-layer";
const STYLE_ID = "spyt-ultra-voice-css";
const SNOWFLAKE = /^\d{17,22}$/;
const HOLD_MS = 4200;
const SHOW_MS = 8000;
const RAF_KEY = "__spytUltraRaf";
const GEN_KEY = "__spytUltraGen";
const GEN = Date.now();
(window as Window & { [GEN_KEY]?: number; })[GEN_KEY] = GEN;

const CSS = `
#${LAYER_ID} {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 99990;
}
.spyt-ultra-tip {
    position: fixed;
    max-width: min(240px, 46vw);
    padding: 5px 8px 6px;
    border-radius: 8px;
    background: rgba(16, 18, 22, 0.9);
    border: 1px solid rgba(35, 165, 90, 0.58);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.38), 0 0 0 1px rgba(35, 165, 90, 0.12);
    color: #f2f3f5;
    font-family: var(--font-primary, "gg sans", "Segoe UI", sans-serif);
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.12s ease, transform 0.12s ease;
    pointer-events: none;
}
.spyt-ultra-tip.is-on {
    opacity: 1;
    transform: none;
}
.spyt-ultra-name {
    display: block;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #23a559;
    margin-bottom: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.spyt-ultra-text {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    font-size: 12px;
    font-weight: 650;
    line-height: 1.3;
}
`;

export type UltraCaption = {
    text: string;
    original?: string;
    partial?: boolean;
    fromLang?: string;
    toLang?: string;
};

type OwnerState = {
    enabled: boolean;
    listening: boolean;
    caption: UltraCaption | null;
};

type TipNode = {
    root: HTMLDivElement;
    name: HTMLSpanElement;
    text: HTMLSpanElement;
};

const owners = new Map<string, OwnerState>();
const spokeAt = new Map<string, number>();
const tileCache = new Map<string, HTMLElement>();

let layer: HTMLDivElement | null = null;
let tip: TipNode | null = null;
let raf = 0;
let lastCaptionText = "";
let utteranceOwner: string | null = null;
let heldCaption: UltraCaption | null = null;
let heldAt = 0;

function ensureCss() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
}

function ensureLayer() {
    ensureCss();
    const all = document.querySelectorAll(`#${LAYER_ID}`);
    layer = all[0] instanceof HTMLDivElement ? all[0] : null;
    for (let i = 1; i < all.length; i++) all[i].remove();
    if (!layer) {
        layer = document.createElement("div");
        layer.id = LAYER_ID;
        document.body.appendChild(layer);
    }
    for (const child of [...layer.children]) {
        if (tip && child === tip.root) continue;
        child.remove();
    }
}

function clearTips() {
    tip?.root.remove();
    tip = null;
    if (layer) layer.replaceChildren();
    lastCaptionText = "";
    utteranceOwner = null;
    heldCaption = null;
    heldAt = 0;
}

function destroyLayer() {
    const w = window as Window & { [RAF_KEY]?: number; };
    if (w[RAF_KEY]) {
        cancelAnimationFrame(w[RAF_KEY]);
        w[RAF_KEY] = 0;
    }
    if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
    }
    clearTips();
    layer?.remove();
    layer = null;
    tileCache.clear();
}

function anyActive() {
    for (const state of owners.values()) {
        if (state.enabled && state.listening) return true;
    }
    return false;
}

function currentCaption(): UltraCaption | null {
    let best: UltraCaption | null = null;
    for (const state of owners.values()) {
        if (state.enabled && state.listening && state.caption?.text)
            best = state.caption;
    }
    return best;
}

function voiceChannelId(): string | undefined {
    try {
        return SelectedChannelStore.getVoiceChannelId?.();
    } catch {
        return undefined;
    }
}

function displayName(userId: string): string {
    try {
        const user = UserStore.getUser(userId);
        const channelId = voiceChannelId();
        const channel = channelId ? ChannelStore.getChannel(channelId) : null;
        const member = channel?.guild_id
            ? GuildMemberStore.getMember(channel.guild_id, userId)
            : null;
        return String(member?.nick || user?.globalName || user?.username || "").trim();
    } catch {
        return "";
    }
}

function considerSpeaker(ids: Map<string, number>, userId: string | null | undefined, speaking: boolean, voiceDb = 0, lastSpoke = 0) {
    if (!speaking || !userId || !SNOWFLAKE.test(userId)) return;
    const score = 1000 + Number(voiceDb || 0) * 10 + Math.min(99, Number(lastSpoke || 0) % 100);
    ids.set(userId, Math.max(ids.get(userId) ?? 0, score));
    spokeAt.set(userId, Date.now());
}

function speakingFromStores(): Map<string, number> {
    const ids = new Map<string, number>();
    const channelId = voiceChannelId();
    const mes = MediaEngineStore as unknown as { isSpeaking?(id: string): boolean; getSpeakingWhileMuted?(): boolean; };

    if (channelId) {
        try {
            const speaking = ChannelRTCStore.getSpeakingParticipants?.(channelId) ?? [];
            for (const p of speaking) {
                if (p?.speaking === false) continue;
                considerSpeaker(ids, p?.user?.id || p?.id, true, Number(p?.voiceDb || 0), Number(p?.lastSpoke || 0));
            }
        } catch { /* ignore */ }
        try {
            const people = ChannelRTCStore.getParticipants?.(channelId) ?? [];
            for (const p of people) {
                const speaking = Boolean((p as { speaking?: boolean; }).speaking);
                if (!speaking) continue;
                const user = "user" in p ? p.user : null;
                considerSpeaker(
                    ids,
                    user?.id || p.id,
                    true,
                    Number((p as { voiceDb?: number; }).voiceDb || 0),
                    Number((p as { lastSpoke?: number; }).lastSpoke || 0)
                );
            }
        } catch { /* ignore */ }
        try {
            const states = VoiceStateStore.getVoiceStatesForChannel?.(channelId) ?? {};
            for (const userId of Object.keys(states)) {
                if (mes.isSpeaking?.(userId)) considerSpeaker(ids, userId, true);
            }
        } catch { /* ignore */ }
    }

    try {
        const selfId = UserStore.getCurrentUser?.()?.id;
        if (selfId && (mes.isSpeaking?.(selfId) || mes.getSpeakingWhileMuted?.()))
            considerSpeaker(ids, selfId, true);
    } catch { /* ignore */ }

    return ids;
}

function currentUserId() {
    try {
        return UserStore.getCurrentUser?.()?.id ?? "";
    } catch {
        return "";
    }
}

function fiberUserId(el: Element): string | null {
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (!key) return null;
    let fiber: { memoizedProps?: Record<string, unknown>; pendingProps?: Record<string, unknown>; return?: unknown; } | null =
        (el as unknown as Record<string, unknown>)[key] as typeof fiber;
    for (let i = 0; i < 12 && fiber; i++) {
        const p = (fiber.memoizedProps || fiber.pendingProps) as Record<string, any> | undefined;
        const candidates = [
            p?.user?.id,
            p?.userId,
            p?.participant?.user?.id,
            p?.participant?.id,
            p?.voiceState?.userId
        ];
        for (const id of candidates) {
            if (typeof id === "string" && SNOWFLAKE.test(id)) return id;
        }
        fiber = fiber.return as typeof fiber;
    }
    return null;
}

function userIdFromEl(el: Element): string | null {
    const node = el as HTMLElement;
    const data = node.dataset?.userId || node.dataset?.userid || node.getAttribute?.("data-user-id");
    if (data && SNOWFLAKE.test(data)) return data;
    const listId = node.getAttribute?.("data-list-item-id") || "";
    const listMatch = listId.match(/(\d{17,22})/);
    if (listMatch) return listMatch[1];
    const img = el instanceof HTMLImageElement ? el : el.querySelector?.("img[src]");
    const src = (img as HTMLImageElement | null)?.currentSrc || (img as HTMLImageElement | null)?.src || "";
    const avatar = src.match(/\/avatars\/(\d{17,22})\//) || src.match(/\/users\/(\d{17,22})\//);
    if (avatar) return avatar[1];
    return fiberUserId(el);
}

function classLooksSpeaking(value: string) {
    if (/notSpeaking|nonSpeaking|speakingStop/i.test(value)) return false;
    return /(?:^|[^\w])speaking(?:[A-Z]|[-_]|$)/.test(value) || /(?:^|[^\w])Speaking/.test(value);
}

function speakingScores(): Map<string, number> {
    return speakingFromStores();
}

function sameUtterance(prev: string, next: string) {
    const a = prev.trim().toLowerCase();
    const b = next.trim().toLowerCase();
    if (!a || !b) return false;
    const n = Math.min(a.length, b.length, 28);
    return b.startsWith(a.slice(0, n)) || a.startsWith(b.slice(0, n));
}

function isVisible(el: HTMLElement) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 16 && r.height >= 16 && r.bottom > 0 && r.right > 0
        && r.top < window.innerHeight && r.left < window.innerWidth;
}

function isListRowRect(r: DOMRectReadOnly) {
    return r.height >= 22 && r.height <= 72 && r.width >= 72 && r.width <= 420;
}

function isCallTileRect(r: DOMRectReadOnly) {
    return r.width >= 120 && r.height >= 88 && r.width < window.innerWidth * 0.72;
}

function inLeftSidebar(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return r.left < Math.min(480, window.innerWidth * 0.42) && r.width <= 480;
}

function isAccountPanel(el: HTMLElement) {
    return Boolean(el.closest('[class*="panels"]')) && inLeftSidebar(el);
}

function isVoiceUserRow(el: HTMLElement) {
    return Boolean(el.closest('[class*="voiceUser"], [class*="VoiceUser"], [class*="userSmall"]'));
}

function isChannelRow(el: HTMLElement) {
    if (isVoiceUserRow(el) || isAccountPanel(el)) return false;
    if (el.closest('a[href^="/channels/"]')) return true;
    const cn = String(el.className || "");
    return /modeConnected|modeSelected|channelName|iconVisibility|linkDefault/i.test(cn);
}

function compactRow(start: HTMLElement, cap: HTMLElement | null): HTMLElement {
    let el: HTMLElement | null = start;
    let best = start;
    for (let i = 0; i < 10 && el && el !== document.body && el !== cap; i++) {
        const r = el.getBoundingClientRect();
        if (r.height >= 32 && r.height <= 72 && r.width >= 80 && r.width <= 420)
            best = el;
        if (r.height > 72 && r.width >= 80) break;
        el = el.parentElement;
    }
    return best;
}

function findAccountBar(userId: string): HTMLElement | null {
    if (userId !== currentUserId()) return null;
    const panels = document.querySelectorAll('[class*="panels"]');
    for (const panel of panels) {
        if (!(panel instanceof HTMLElement) || !inLeftSidebar(panel)) continue;
        const r = panel.getBoundingClientRect();
        if (r.bottom < window.innerHeight * 0.55) continue;
        const avatar = panel.querySelector(
            `img[src*="/avatars/${userId}/"], img[src*="/users/${userId}/"], img[srcset*="/avatars/${userId}/"]`
        );
        const anchor = (avatar instanceof HTMLElement ? avatar : null)
            || (panel.querySelector('[class*="avatarWrapper"], [class*="nameTag"], [class*="avatar"]') as HTMLElement | null)
            || panel;
        const row = compactRow(anchor, panel);
        if (isVisible(row)) return row;
    }
    return null;
}

function voiceContainer(start: HTMLElement): HTMLElement {
    let el: HTMLElement | null = start;
    let rowHit: HTMLElement | null = null;
    let speakingHit: HTMLElement | null = null;
    let tileHit: HTMLElement | null = null;
    for (let i = 0; i < 16 && el && el !== document.body; i++) {
        if (el.id === "app-mount") break;
        const r = el.getBoundingClientRect();
        if (r.width > window.innerWidth * 0.82 || r.height > window.innerHeight * 0.55) break;
        const cn = String(el.className || "");
        if (isChannelRow(el)) {
            el = el.parentElement;
            continue;
        }
        if (/voiceUser|VoiceUser|userSmall/i.test(cn) && r.height <= 72) rowHit = el;
        else if (isAccountPanel(el) && isListRowRect(r)) rowHit = el;
        else if (isListRowRect(r) && (isVoiceUserRow(el) || isAccountPanel(el))) rowHit = el;
        if (classLooksSpeaking(cn) && r.width >= 28 && r.height <= 72 && !isChannelRow(el))
            speakingHit = el;
        if (isCallTileRect(r)) tileHit = el;
        el = el.parentElement;
    }
    return rowHit || speakingHit || tileHit || start;
}

function collectHits(userId: string): HTMLElement[] {
    const hits: HTMLElement[] = [];
    const push = (node: Element | null) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.closest(`#${LAYER_ID}, #spyt-live-root, #spyt-live2-root`)) return;
        if (isChannelRow(node)) return;
        const box = voiceContainer(node);
        if (isChannelRow(box)) return;
        if (!hits.includes(box) && isVisible(box)) hits.push(box);
    };

    document.querySelectorAll(
        `img[src*="/avatars/${userId}/"], img[src*="/users/${userId}/"], img[srcset*="/avatars/${userId}/"]`
    ).forEach(push);

    document.querySelectorAll(
        `[data-user-id="${userId}"], [data-list-item-id*="${userId}"], [data-participant-id="${userId}"]`
    ).forEach(push);

    document.querySelectorAll('[class*="voiceUser"], [class*="VoiceUser"], [class*="userSmall"]').forEach(node => {
        if (userIdFromEl(node) === userId) push(node);
    });
    return hits;
}

function rowScore(el: HTMLElement, userId: string) {
    const r = el.getBoundingClientRect();
    if (!el.isConnected || !isVisible(el)) return -1;
    const self = userId === currentUserId();
    if (self && isAccountPanel(el)) return 8000 - Math.abs(window.innerHeight - r.bottom);
    if (isVoiceUserRow(el)) return 4000 - r.top;
    if (isCallTileRect(r)) return 500;
    if (self && inLeftSidebar(el) && r.bottom > window.innerHeight * 0.7) return 3000 - Math.abs(window.innerHeight - r.bottom);
    if (isChannelRow(el) || r.top < 80) return 1;
    if (isListRowRect(r)) return 100;
    return r.width * r.height / 1000;
}

function findTile(userId: string): HTMLElement | null {
    if (userId === currentUserId()) {
        const bar = findAccountBar(userId);
        if (bar) {
            tileCache.set(userId, bar);
            return bar;
        }
    }
    const cached = tileCache.get(userId);
    if (cached?.isConnected && isVisible(cached) && !isChannelRow(cached)
        && (isVoiceUserRow(cached) || isAccountPanel(cached) || isCallTileRect(cached.getBoundingClientRect())))
        return cached;

    const hits = collectHits(userId);
    if (!hits.length) {
        tileCache.delete(userId);
        return null;
    }
    hits.sort((a, b) => rowScore(b, userId) - rowScore(a, userId));
    const best = hits[0];
    if (!best || rowScore(best, userId) < 50) {
        tileCache.delete(userId);
        return null;
    }
    tileCache.set(userId, best);
    return best;
}

function placeTip(tip: HTMLElement, tile: HTMLElement) {
    const r = tile.getBoundingClientRect();
    const tw = Math.max(tip.offsetWidth || 0, 120);
    const th = Math.max(tip.offsetHeight || 0, 40);
    let left = r.right + 8;
    let top = r.top + (r.height - th) / 2;
    if (isCallTileRect(r) && !isAccountPanel(tile) && !isVoiceUserRow(tile)) {
        left = r.left + 10;
        top = r.bottom - th - 38;
        if (top < r.top + 8) top = r.top + 8;
    }
    if (left + tw > window.innerWidth - 8)
        left = Math.max(8, r.left - tw - 8);
    if (top < 8) top = 8;
    if (top + th > window.innerHeight - 8)
        top = Math.max(8, window.innerHeight - th - 8);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
}

function hideTip() {
    tip?.root.classList.remove("is-on");
}

function showTip(userId: string, caption: UltraCaption) {
    ensureLayer();
    if (!tip?.root.isConnected) {
        const root = document.createElement("div");
        root.className = "spyt-ultra-tip";
        const name = document.createElement("span");
        name.className = "spyt-ultra-name";
        const text = document.createElement("span");
        text.className = "spyt-ultra-text";
        root.append(name, text);
        layer!.appendChild(root);
        tip = { root, name, text };
    }
    for (const child of [...layer!.children]) {
        if (child !== tip.root) child.remove();
    }
    const tile = findTile(userId);
    if (!tile) {
        hideTip();
        return;
    }
    const name = displayName(userId);
    const langs = languagePairLabel(caption.fromLang, caption.toLang, caption.original, caption.text);
    tip.root.dataset.userId = userId;
    tip.name.textContent = name ? (langs !== "Spoken" ? `${name} · ${langs}` : name) : langs || "Speaking";
    tip.text.textContent = caption.text;
    const spoken = (caption.original || "").trim();
    const titleBits = [langs !== "Spoken" ? langs : "", spoken && spoken !== caption.text ? spoken : ""].filter(Boolean);
    tip.root.title = titleBits.join("\n");
    tip.root.classList.toggle("is-live", Boolean(caption.partial));
    tip.root.classList.add("is-on");
    placeTip(tip.root, tile);
}

function bestSpeaker(scores: Map<string, number>): string | null {
    let bestId: string | null = null;
    let best = -Infinity;
    for (const [id, score] of scores) {
        if (score > best) {
            best = score;
            bestId = id;
        }
    }
    return bestId;
}

function stillOwner(id: string, scores: Map<string, number>, now: number) {
    return scores.has(id) || now - (spokeAt.get(id) ?? 0) < HOLD_MS;
}

function lastSpeaker(now: number): string | null {
    let bestId: string | null = null;
    let bestAt = 0;
    for (const [id, at] of spokeAt) {
        if (now - at < HOLD_MS && at >= bestAt) {
            bestAt = at;
            bestId = id;
        }
    }
    return bestId;
}

function loop() {
    raf = 0;
    const w = window as Window & { [GEN_KEY]?: number; [RAF_KEY]?: number; };
    if (w[GEN_KEY] !== GEN) return;
    if (!anyActive()) {
        clearTips();
        return;
    }
    ensureLayer();
    const now = Date.now();
    const caption = currentCaption();
    const scores = speakingScores();
    const speaker = bestSpeaker(scores);

    if (caption?.text) {
        const continued = sameUtterance(lastCaptionText, caption.text);
        lastCaptionText = caption.text;
        if (!(continued && utteranceOwner && stillOwner(utteranceOwner, scores, now)))
            utteranceOwner = speaker || lastSpeaker(now);
        heldCaption = caption;
        heldAt = now;
        if (utteranceOwner) showTip(utteranceOwner, caption);
        else hideTip();
    } else if (heldCaption && utteranceOwner && now - heldAt < SHOW_MS) {
        showTip(utteranceOwner, heldCaption);
    } else {
        hideTip();
        heldCaption = null;
        utteranceOwner = null;
        lastCaptionText = "";
    }
    schedule();
}

function schedule() {
    const w = window as Window & { [GEN_KEY]?: number; [RAF_KEY]?: number; };
    if (w[GEN_KEY] !== GEN) return;
    if (w[RAF_KEY]) cancelAnimationFrame(w[RAF_KEY]);
    if (raf) cancelAnimationFrame(raf);
    if (!anyActive()) return;
    raf = requestAnimationFrame(loop);
    w[RAF_KEY] = raf;
}

function syncLoop() {
    if (anyActive()) {
        ensureLayer();
        schedule();
        return;
    }
    destroyLayer();
}

function owner(id: string): OwnerState {
    let state = owners.get(id);
    if (!state) {
        state = { enabled: false, listening: false, caption: null };
        owners.set(id, state);
    }
    return state;
}

export function setUltraEnabled(id: string, enabled: boolean) {
    const state = owner(id);
    state.enabled = enabled;
    if (!enabled) state.caption = null;
    syncLoop();
}

export function setUltraListening(id: string, listening: boolean) {
    owner(id).listening = listening;
    if (!listening) owner(id).caption = null;
    syncLoop();
}

export function setUltraCaption(id: string, caption: UltraCaption | null) {
    owner(id).caption = caption && caption.text ? caption : null;
    syncLoop();
}

export function disposeUltra(id: string) {
    owners.delete(id);
    syncLoop();
}
