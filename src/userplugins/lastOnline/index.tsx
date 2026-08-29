/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 SpyT / Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Delexo } from "../_delexo/author";
import { mutationClassMatches } from "../_delexo/idle";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, PresenceStore, SelectedChannelStore, createRoot } from "@webpack/common";
import type { Root } from "react-dom/client";

import managedStyle from "./style.css?managed";

const STORE_KEY = "LastOnlineTimestamps";
const SEEN_KEY = "LastOnlineSeenOnline";
const UI_PLACE_RE = /title|subtitle|userProfile|userPopout|profilePanel|chat/;

type TipKind = "last" | "unknown";

type TipInfo = {
    kind: TipKind;
    text: string;
};

const settings = definePluginSettings({
    showInHeader: {
        type: OptionType.BOOLEAN,
        description: "Show status under the Direct Messages title in the chat header",
        default: true
    },
    showInProfile: {
        type: OptionType.BOOLEAN,
        description: "Show status to the right of the display name on full profiles",
        default: true
    }
});

/** userId -> ms when they last went fully offline */
let offlineAt: Record<string, number> = {};
/** users we have observed online this session (or previously) */
let seenOnline: Set<string> = new Set();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

let tipRoot: Root | null = null;
let tipMount: HTMLDivElement | null = null;
let tipInfo: TipInfo | null = null;
let tipX = 0;
let tipY = 0;
let tipVisible = false;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

let headerHost: HTMLDivElement | null = null;
let headerRoot: Root | null = null;
let profileHost: HTMLElement | null = null;
let profileRoot: Root | null = null;
let uiObserver: MutationObserver | null = null;
let timerHandle: ReturnType<typeof setTimeout> | null = null;
let placeTimer: ReturnType<typeof setTimeout> | null = null;
/** Last hovered DM row (for live tip refresh while pointer stays put). */
let tipRow: Element | null = null;
let tipUserId: string | null = null;

function scheduleSave() {
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        void DataStore.set(STORE_KEY, offlineAt);
        void DataStore.set(SEEN_KEY, [...seenOnline]);
    }, 800);
}

function isActiveStatus(status: string | undefined | null) {
    return status === "online" || status === "idle" || status === "dnd";
}

function formatAgo(ms: number) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) {
        const remMin = min % 60;
        return remMin > 0 ? `${hr}h ${remMin}m ago` : `${hr}h ago`;
    }
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    const week = Math.floor(day / 7);
    if (week < 5) return `${week}w ago`;
    const month = Math.floor(day / 30);
    if (month < 12) return `${month}mo ago`;
    return `${Math.floor(day / 365)}y ago`;
}

/** How often to refresh "Xm ago" text based on how recent the offline stamp is. */
function tickDelayForAge(ms: number) {
    if (ms < 60_000) return 1_000;
    if (ms < 3_600_000) return 15_000;
    if (ms < 86_400_000) return 60_000;
    return 5 * 60_000;
}

function reconcileUser(userId: string | null | undefined) {
    if (!userId) return;
    try {
        const status = PresenceStore.getStatus(userId) as string | undefined;
        const clientStatus = PresenceStore.getClientStatus?.(userId) as Record<string, string> | null | undefined;
        handlePresence(userId, status, clientStatus ?? null);
    } catch { /* ignore */ }
}

function handlePresence(
    userId: string,
    status: string | undefined,
    clientStatus?: Record<string, string> | null
) {
    if (!userId) return;

    const fullyOffline =
        (status === "offline" || status === "invisible" || !status) &&
        (!clientStatus || Object.keys(clientStatus).length === 0);

    if (!fullyOffline && isActiveStatus(status)) {
        seenOnline.add(userId);
        if (offlineAt[userId] != null) {
            delete offlineAt[userId];
            scheduleSave();
            scheduleTimer();
        }
        queueUiPlace();
        return;
    }

    if (fullyOffline && seenOnline.has(userId) && offlineAt[userId] == null) {
        offlineAt[userId] = Date.now();
        seenOnline.delete(userId);
        scheduleSave();
        scheduleTimer();
        queueUiPlace();
    }
}

function tipForUser(userId: string | undefined | null): TipInfo | null {
    if (!userId) return null;

    const status = (PresenceStore.getStatus(userId) as string | undefined) || "offline";
    if (isActiveStatus(status)) return null;

    const ts = offlineAt[userId];
    if (ts != null) {
        return {
            kind: "last",
            text: `Last online ${formatAgo(Date.now() - ts)}`
        };
    }

    return { kind: "unknown", text: "TBD..." };
}

function parseListItemChannelId(el: Element): string | null {
    const raw =
        el.getAttribute("data-list-item-id") ||
        el.closest("[data-list-item-id]")?.getAttribute("data-list-item-id") ||
        "";
    const m = raw.match(/channel___(\d+)/i) || raw.match(/___(\d+)$/);
    return m?.[1] ?? null;
}

function isInPrivateChannelsList(el: Element) {
    return Boolean(
        el.closest('[class*="privateChannels"]') ||
        el.closest('[class*="PrivateChannels"]') ||
        el.closest('nav[aria-label="Private channels" i]') ||
        el.closest('nav[aria-label="Direct Messages" i]') ||
        el.closest('[class*="privateChannels__"]')
    );
}

function recipientFromChannel(ch: any): string | null {
    if (!ch) return null;
    if (ch.isMultiUserDM?.() || (ch.recipients?.length ?? 0) > 1) return null;
    if (!ch.isDM?.() && ch.type !== 1) return null;
    const recipients = ch.recipients ?? [];
    if (recipients.length === 1) return recipients[0];
    return ch.recipientId || ch.rawRecipients?.[0]?.id || null;
}

function userIdFromDmRow(el: Element): string | null {
    const channelId = parseListItemChannelId(el);
    if (!channelId) return null;
    try {
        return recipientFromChannel(ChannelStore.getChannel(channelId));
    } catch {
        return null;
    }
}

function currentDmPeerId(): string | null {
    try {
        const channelId = SelectedChannelStore.getChannelId?.();
        if (!channelId) return null;
        return recipientFromChannel(ChannelStore.getChannel(channelId));
    } catch {
        return null;
    }
}

function resolveHeaderBar(initial: HTMLElement | null): HTMLElement | null {
    if (!initial) return null;

    let bar: HTMLElement | null = initial;
    for (let i = 0; i < 6 && bar; i++) {
        const rect = bar.getBoundingClientRect();
        const hasToolbar = bar.querySelector(
            '[class*="toolbar"], [aria-label*="Voice Call" i], [aria-label*="Start a Voice Call" i]'
        );
        const hasTitle = bar.querySelector('[class*="children"], [class*="title"], h1, h2, h3');
        if (hasToolbar && hasTitle && rect.width >= 320) return bar;
        bar = bar.parentElement;
    }

    return initial;
}

function findDmHeaderBar(): HTMLElement | null {
    const callBtn =
        document.querySelector<HTMLElement>('[aria-label*="Voice Call" i]') ||
        document.querySelector<HTMLElement>('[aria-label*="Start a Voice Call" i]') ||
        document.querySelector<HTMLElement>('[aria-label="Call" i]');
    if (callBtn) {
        const bar = resolveHeaderBar(
            callBtn.closest<HTMLElement>('[class*="title"][class*="container"]') ||
            callBtn.closest<HTMLElement>('[class*="title"]') ||
            callBtn.closest<HTMLElement>("section") ||
            callBtn.parentElement?.parentElement ||
            null
        );
        if (bar) return bar;
    }

    const search =
        document.querySelector<HTMLElement>('form[class*="search"]') ||
        document.querySelector<HTMLElement>('[class*="searchBar"]');
    if (search) {
        const bar = resolveHeaderBar(
            search.closest<HTMLElement>('[class*="title"][class*="container"]') ||
            search.closest<HTMLElement>('[class*="title"]') ||
            search.closest<HTMLElement>("section") ||
            null
        );
        if (bar) return bar;
    }

    return resolveHeaderBar(
        document.querySelector<HTMLElement>('[class*="title"][class*="container"]')
    );
}

let cachedDmLabel: HTMLElement | null = null;

/** Find the window "Direct Messages" / Discord title label to align under. */
function findDirectMessagesLabel(): HTMLElement | null {
    if (cachedDmLabel?.isConnected) return cachedDmLabel;
    cachedDmLabel = null;
    const root =
        document.querySelector<HTMLElement>('[class*="titleBar"]') ||
        document.querySelector<HTMLElement>('[class*="wordmark"]') ||
        document.querySelector<HTMLElement>('[class*="appTitle"]');
    if (!root) return null;
    for (const el of root.querySelectorAll<HTMLElement>("span, div")) {
        if (el.children.length > 2) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!/^(Direct Messages|Discord)$/i.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.top > 48 || r.height > 40) continue;
        cachedDmLabel = el;
        return el;
    }
    return null;
}

/**
 * Horizontal position inside the chat header, aligned under the
 * Direct Messages window title (shifted left vs gap-center).
 */
function headerBadgeLeft(bar: HTMLElement): number {
    const barRect = bar.getBoundingClientRect();
    if (barRect.width <= 0) return barRect.width / 2;

    const dmLabel = findDirectMessagesLabel();
    if (dmLabel) {
        const labelRect = dmLabel.getBoundingClientRect();
        // Center of the Direct Messages label, relative to the chat header bar
        let left = labelRect.left + labelRect.width / 2 - barRect.left;
        // Nudge further left so it doesn't feel offset toward the icons
        left -= 28;
        return Math.max(80, Math.min(barRect.width - 80, left));
    }

    // Fallback: left-biased center of the free gap
    const titleEl =
        bar.querySelector<HTMLElement>(':scope > [class*="children"]') ||
        bar.querySelector<HTMLElement>('[class*="children"]');
    const toolbarEl =
        bar.querySelector<HTMLElement>(':scope > [class*="toolbar"]') ||
        bar.querySelector<HTMLElement>('[class*="toolbar"]');

    const leftEdge = titleEl
        ? Math.min(Math.max(titleEl.getBoundingClientRect().right + 16, barRect.left), barRect.right)
        : barRect.left + 120;
    const rightEdge = toolbarEl
        ? Math.max(Math.min(toolbarEl.getBoundingClientRect().left - 16, barRect.right), barRect.left)
        : barRect.right - 180;

    if (rightEdge - leftEdge < 56) return barRect.width * 0.38;
    // Prefer left third of the gap (under DM title area)
    return leftEdge - barRect.left + (rightEdge - leftEdge) * 0.28;
}

function StatusBadge({ info, compact }: { info: TipInfo; compact?: boolean; }) {
    return (
        <div
            className={`vc-last-online-header vc-last-online-${info.kind}${compact ? " vc-last-online-compact" : ""}`}
            role="status"
        >
            <span className="vc-last-online-dot" aria-hidden="true" />
            <span className="vc-last-online-text">{info.text}</span>
        </div>
    );
}

function renderHeaderBadge(info: TipInfo | null) {
    if (!headerHost || !headerRoot) return;
    headerRoot.render(info ? <StatusBadge info={info} /> : null);
}

function removeHeaderBadge() {
    headerRoot?.unmount();
    headerRoot = null;
    headerHost?.remove();
    headerHost = null;
}

function placeHeaderBadge() {
    if (!settings.store.showInHeader) {
        removeHeaderBadge();
        return;
    }

    const userId = currentDmPeerId();
    const info = tipForUser(userId);
    const bar = findDmHeaderBar();

    if (!userId || !info || !bar) {
        removeHeaderBadge();
        return;
    }

    if (getComputedStyle(bar).position === "static")
        bar.style.position = "relative";

    if (!headerHost || headerHost.parentElement !== bar) {
        removeHeaderBadge();
        headerHost = document.createElement("div");
        headerHost.id = "vc-last-online-header-host";
        headerHost.className = "vc-last-online-header-host";
        bar.appendChild(headerHost);
        headerRoot = createRoot(headerHost);
    }

    headerHost.style.left = `${Math.round(headerBadgeLeft(bar))}px`;
    renderHeaderBadge(info);
}

function findUserIdNear(el: Element | null): string | null {
    let cur: Element | null = el;
    for (let i = 0; i < 24 && cur; i++) {
        const fiberKey = Object.keys(cur).find(k =>
            k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
        );
        let fiber: any = fiberKey ? (cur as any)[fiberKey] : null;
        for (let d = 0; d < 18 && fiber; d++, fiber = fiber.return) {
            const p = fiber.memoizedProps || fiber.pendingProps || {};
            if (p.user?.id) return String(p.user.id);
            if (p.userId) return String(p.userId);
            if (typeof p.id === "string" && /^\d{16,20}$/.test(p.id) && p.username) return p.id;
        }
        cur = cur.parentElement;
    }
    return null;
}

function findProfileDisplayName(): HTMLElement | null {
    const modal =
        document.querySelector<HTMLElement>('[class*="userProfileModal"]') ||
        document.querySelector<HTMLElement>('[class*="userProfileOuter"]') ||
        document.querySelector<HTMLElement>('[class*="profilePanel"]');
    if (!modal) return null;

    // Prefer nickname / display name heading near the top of the profile sidebar
    const headings = modal.querySelectorAll<HTMLElement>('h1, h2, h3, [class*="nickname"], [class*="displayName"], [class*="username"]');
    for (const el of headings) {
        if (el.closest("#vc-last-online-profile-host, .vc-last-online-header-host")) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 40) continue;
        if (/^(activity|mutual|message|note|member since|friends since)$/i.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 16) continue;
        // Display names are usually large and near the left column
        if (r.left > window.innerWidth * 0.55) continue;
        return el;
    }
    return null;
}

function removeProfileBadge() {
    profileRoot?.unmount();
    profileRoot = null;
    profileHost?.remove();
    profileHost = null;
}

function placeProfileBadge() {
    if (!settings.store.showInProfile) {
        removeProfileBadge();
        return;
    }

    const nameEl = findProfileDisplayName();
    if (!nameEl) {
        if (profileHost && !document.body.contains(profileHost)) removeProfileBadge();
        return;
    }

    const userId = findUserIdNear(nameEl);
    const info = tipForUser(userId);
    if (!userId || !info) {
        removeProfileBadge();
        return;
    }

    // Wrap name + badge in an inline flex row when needed
    let row = nameEl.parentElement;
    if (!row) return;

    // If the name is alone, use its parent; ensure horizontal layout for the badge
    if (!profileHost || !row.contains(profileHost)) {
        removeProfileBadge();
        profileHost = document.createElement("span");
        profileHost.id = "vc-last-online-profile-host";
        profileHost.className = "vc-last-online-profile-host";
        profileHost.setAttribute("data-user-id", userId);

        if (nameEl.nextSibling)
            row.insertBefore(profileHost, nameEl.nextSibling);
        else
            row.appendChild(profileHost);

        // Keep display name and badge on one line
        if (getComputedStyle(row).display === "block") {
            row.classList.add("vc-last-online-profile-name-row");
        }

        profileRoot = createRoot(profileHost);
    } else if (profileHost.getAttribute("data-user-id") !== userId) {
        profileHost.setAttribute("data-user-id", userId);
    }

    profileRoot?.render(<StatusBadge info={info} compact />);
}

function placeAllUi() {
    try { placeHeaderBadge(); } catch { /* ignore */ }
    try { placeProfileBadge(); } catch { /* ignore */ }
}

function queueUiPlace() {
    if (placeTimer != null) return;
    placeTimer = setTimeout(() => {
        placeTimer = null;
        placeAllUi();
    }, 120);
}

function renderTip() {
    if (!tipMount || !tipRoot) return;
    tipRoot.render(
        tipVisible && tipInfo
            ? (
                <div
                    className={`vc-last-online-tooltip vc-last-online-${tipInfo.kind}`}
                    role="tooltip"
                    style={{ left: tipX, top: tipY }}
                >
                    <span className="vc-last-online-dot" aria-hidden="true" />
                    <span className="vc-last-online-text">{tipInfo.text}</span>
                    <span className="vc-last-online-tooltip-arrow" aria-hidden="true" />
                </div>
            )
            : null
    );
}

function showTip(info: TipInfo, row: Element, userId?: string | null) {
    if (hideTimer != null) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    const rect = row.getBoundingClientRect();
    tipInfo = info;
    tipRow = row;
    tipUserId = userId ?? tipUserId;
    tipX = Math.round(rect.right + 10);
    tipY = Math.round(rect.top + rect.height / 2);
    tipVisible = true;
    renderTip();
    scheduleTimer();
}

function hideTipSoon() {
    if (hideTimer != null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        tipVisible = false;
        tipInfo = null;
        tipRow = null;
        tipUserId = null;
        renderTip();
        scheduleTimer();
    }, 80);
}

function refreshLiveTip() {
    if (!tipVisible || !tipRow || !document.contains(tipRow)) return;
    if (tipUserId) reconcileUser(tipUserId);
    const info = tipForUser(tipUserId);
    if (!info) {
        tipVisible = false;
        tipInfo = null;
        tipRow = null;
        tipUserId = null;
        renderTip();
        return;
    }
    tipInfo = info;
    const rect = tipRow.getBoundingClientRect();
    tipX = Math.round(rect.right + 10);
    tipY = Math.round(rect.top + rect.height / 2);
    renderTip();
}

function scheduleTimer() {
    if (timerHandle != null) clearTimeout(timerHandle);

    const peerId = currentDmPeerId();
    const ages: number[] = [];
    if (peerId && offlineAt[peerId] != null)
        ages.push(Date.now() - offlineAt[peerId]);
    if (tipVisible && tipUserId && offlineAt[tipUserId] != null)
        ages.push(Date.now() - offlineAt[tipUserId]);
    if (profileHost) {
        const pid = profileHost.getAttribute("data-user-id");
        if (pid && offlineAt[pid] != null)
            ages.push(Date.now() - offlineAt[pid]);
    }

    // Keep UI placement fresh even when everyone is online / unknown
    const delay = ages.length
        ? Math.min(...ages.map(tickDelayForAge))
        : 15_000;

    timerHandle = setTimeout(() => {
        timerHandle = null;
        try {
            reconcileUser(peerId);
            if (tipVisible) refreshLiveTip();
            queueUiPlace();
        } finally {
            scheduleTimer();
        }
    }, delay);
}

function onPointerOver(e: Event) {
    const t = e.target as Element | null;
    if (!t?.closest) return;
    if (!isInPrivateChannelsList(t)) {
        if (tipVisible) hideTipSoon();
        return;
    }
    const row = t.closest("[data-list-item-id]") || t.closest('[class*="channel"]');
    if (!row || !isInPrivateChannelsList(row)) {
        if (tipVisible) hideTipSoon();
        return;
    }
    const label = (row.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("friends") || label.includes("nitro") || label.includes("shop")) {
        if (tipVisible) hideTipSoon();
        return;
    }

    const userId = userIdFromDmRow(row);
    reconcileUser(userId);
    const info = tipForUser(userId);
    if (!info) {
        if (tipVisible) hideTipSoon();
        return;
    }
    showTip(info, row, userId);
}

function onPointerOut(e: Event) {
    const ev = e as MouseEvent;
    const to = ev.relatedTarget as Element | null;
    if (to && tipMount?.contains(to)) return;
    if (to && isInPrivateChannelsList(to) && to.closest("[data-list-item-id]")) return;
    hideTipSoon();
}

function ensureTipHost() {
    if (tipMount) return;
    tipMount = document.createElement("div");
    tipMount.id = "vc-last-online-tooltip-root";
    document.body.appendChild(tipMount);
    tipRoot = createRoot(tipMount);
}

function teardownTipHost() {
    tipRoot?.unmount();
    tipRoot = null;
    tipMount?.remove();
    tipMount = null;
    tipVisible = false;
    tipInfo = null;
    tipRow = null;
    tipUserId = null;
}

export default definePlugin({
    name: "Last Online",
    description: "Shows how long a user has been offline in DMs, sidebar hover, and full profiles",
    tags: ["Friends", "Utility", "Appearance"],
    searchTerms: ["last online", "offline", "presence", "dm", "tooltip", "header", "profile", "tbd"],
    authors: [Delexo],
    settings,
    managedStyle,

    flux: {
        PRESENCE_UPDATES({
            updates
        }: {
            updates?: Array<{
                user?: { id?: string; };
                status?: string;
                clientStatus?: Record<string, string>;
            }>;
        }) {
            if (!updates?.length) return;
            for (const u of updates) {
                const id = u.user?.id;
                if (!id) continue;
                handlePresence(id, u.status, u.clientStatus);
            }
            queueUiPlace();
        },
        CHANNEL_SELECT() {
            queueUiPlace();
            scheduleTimer();
        },
        CHANNEL_SELECT_V2() {
            queueUiPlace();
            scheduleTimer();
        },
        USER_PROFILE_MODAL_OPEN() {
            queueUiPlace();
            scheduleTimer();
        }
    },

    async start() {
        offlineAt = (await DataStore.get<Record<string, number>>(STORE_KEY)) ?? {};
        const seen = (await DataStore.get<string[]>(SEEN_KEY)) ?? [];
        seenOnline = new Set(seen);

        try {
            for (const id of PresenceStore.getUserIds?.() ?? []) {
                reconcileUser(id);
            }
            // Anyone we previously marked online but PresenceStore says offline now
            // (e.g. Discord restarted while they were away) gets stamped offline.
            for (const id of [...seenOnline]) {
                const status = PresenceStore.getStatus(id) as string | undefined;
                if (!isActiveStatus(status) && offlineAt[id] == null) {
                    offlineAt[id] = Date.now();
                    seenOnline.delete(id);
                }
            }
            scheduleSave();
        } catch { /* ignore */ }

        ensureTipHost();
        document.addEventListener("pointerover", onPointerOver, true);
        document.addEventListener("pointerout", onPointerOut, true);

        uiObserver = new MutationObserver(records => {
            if (mutationClassMatches(records, UI_PLACE_RE)) queueUiPlace();
        });
        uiObserver.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("resize", queueUiPlace);
        queueUiPlace();
        scheduleTimer();
    },

    stop() {
        document.removeEventListener("pointerover", onPointerOver, true);
        document.removeEventListener("pointerout", onPointerOut, true);
        window.removeEventListener("resize", queueUiPlace);
        if (hideTimer != null) clearTimeout(hideTimer);
        teardownTipHost();
        uiObserver?.disconnect();
        uiObserver = null;
        if (placeTimer != null) clearTimeout(placeTimer);
        placeTimer = null;
        if (timerHandle != null) clearTimeout(timerHandle);
        timerHandle = null;
        tipRow = null;
        tipUserId = null;
        cachedDmLabel = null;
        removeHeaderBadge();
        removeProfileBadge();
        if (saveTimer != null) clearTimeout(saveTimer);
        void DataStore.set(STORE_KEY, offlineAt);
        void DataStore.set(SEEN_KEY, [...seenOnline]);
    }
});
