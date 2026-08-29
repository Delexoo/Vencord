/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, FluxDispatcher, RestAPI, SelectedGuildStore, UserProfileStore, UserStore } from "@webpack/common";

import type { ShareState } from "../badges/share";
import type { ButtonShare } from "../profileButton/share";

const WRITE_MS = 150;
const POLL_MS = 5000;
const FETCH_MIN_MS = 15000;
const SCAN_MS = 200;
let bioWriteChain: Promise<void> = Promise.resolve();
const PROFILE_OPEN_RE = /userProfileModal|userProfileOuter|userPopoutOuter|profilePanel|biteSize/;

const lastFetchAt = new Map<string, number>();
const inFlight = new Map<string, Promise<ReturnType<typeof UserProfileStore.getUserProfile>>>();
let visibleIds = new Set<string>();
let refs = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let openObserver: MutationObserver | null = null;
let bioObserver: MutationObserver | null = null;

function profileRoots() {
    return [...document.querySelectorAll<HTMLElement>([
        '[class*="userProfileModal"]',
        '[class*="userProfileOuter"]',
        '[class*="userProfileInner"]',
        '[class*="userPopoutOuter"]',
        '[class*="userPopoutInner"]',
        '[class*="profilePanel"]',
        '[class*="biteSize"]',
    ].join(","))];
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

let hideTimer = 0;
let scanTimer = 0;

function visibleShareText(text: string) {
    let out = "";
    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp >= 0xe0000 && cp <= 0xe007f) continue;
        if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfe0f || cp === 0x2060) continue;
        if (/\s/.test(ch)) continue;
        out += ch;
    }
    return out;
}

function hasShareTags(text: string) {
    if (text.includes("\u2060") && /[\u200b\u200c]/.test(text)) return true;
    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp >= 0xe0000 && cp <= 0xe007f) return true;
    }
    return false;
}

function hideGhostShareBios() {
    for (const root of profileRoots()) {
        for (const el of root.querySelectorAll<HTMLElement>("[data-vc-share-bio-hidden]")) {
            const vis = visibleShareText(el.textContent ?? "");
            if (vis && !/^(about\s*me|about|bio)$/i.test(vis)) {
                el.style.removeProperty("display");
                el.removeAttribute("data-vc-share-bio-hidden");
            }
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const starts = new Set<HTMLElement>();
        let node: Node | null;
        while ((node = walker.nextNode())) {
            const text = node.nodeValue ?? "";
            if (!hasShareTags(text) || visibleShareText(text)) continue;
            const parent = node.parentElement;
            if (parent) starts.add(parent);
        }

        for (const start of starts) {
            if (!start.isConnected || start.closest("[data-vc-share-bio-hidden]")) continue;
            if (start.closest(".vc-profile-button-host, .vc-nickname-panel")) continue;
            if (start.closest('[class*="widget"], [class*="connectedAccount"], [class*="roles"], [class*="badge"]')) continue;
            if (start.querySelector("img, button, input, textarea, canvas, video, a")) continue;

            let target = start;
            for (let i = 0; i < 8 && target.parentElement && target.parentElement !== root; i++) {
                const parent = target.parentElement;
                if (parent.querySelector("img, button, input, textarea, canvas, video")) break;
                const vis = visibleShareText(parent.textContent ?? "");
                if (vis && !/^(about\s*me|about|bio)$/i.test(vis)) break;
                if (parent.getBoundingClientRect().height > 160) break;
                target = parent;
            }

            const box = target.getBoundingClientRect();
            if (box.height < 4 || box.height > 80) continue;
            if (target === root) continue;
            target.style.setProperty("display", "none", "important");
            target.setAttribute("data-vc-share-bio-hidden", "1");
        }
    }
}

function scheduleHideGhostBios() {
    if (hideTimer) return;
    hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        try { hideGhostShareBios(); } catch { /* ignore */ }
    }, 80);
}

function scanVisibleIds() {
    const next = new Set<string>();
    for (const root of profileRoots()) {
        const id = findUserIdNear(root);
        if (id) next.add(id);
    }
    return next;
}

function isDiscordFetching(userId: string) {
    try {
        return Boolean(UserProfileStore.isFetchingProfile?.(userId));
    } catch {
        return false;
    }
}

export async function refreshUserProfile(userId: string, force = false) {
    if (!userId) return UserProfileStore.getUserProfile(userId);
    const cached = UserProfileStore.getUserProfile(userId);
    if (isDiscordFetching(userId)) return cached;
    const now = Date.now();
    const prev = lastFetchAt.get(userId) ?? 0;
    if (!force && cached && prev > 0 && now - prev < FETCH_MIN_MS) return cached;
    const existing = inFlight.get(userId);
    if (existing) return existing;

    const pending = (async () => {
        try {
            if (isDiscordFetching(userId)) return UserProfileStore.getUserProfile(userId);
            const guildId = SelectedGuildStore.getGuildId?.() || undefined;
            const { body } = await RestAPI.get({
                url: Constants.Endpoints.USER_PROFILE(userId),
                query: {
                    with_mutual_guilds: true,
                    with_mutual_friends: true,
                    with_mutual_friends_count: true,
                    ...(guildId ? { guild_id: guildId } : {})
                },
                oldFormErrors: true,
            });
            if (!body?.user) return UserProfileStore.getUserProfile(userId);
            if (isDiscordFetching(userId)) return UserProfileStore.getUserProfile(userId);
            FluxDispatcher.dispatch({ type: "USER_UPDATE", user: body.user });
            await FluxDispatcher.dispatch({ type: "USER_PROFILE_FETCH_SUCCESS", userProfile: body });
            if (guildId && body.guild_member) {
                FluxDispatcher.dispatch({
                    type: "GUILD_MEMBER_PROFILE_UPDATE",
                    guildId,
                    guildMember: body.guild_member
                });
            }
            lastFetchAt.set(userId, Date.now());
            bumpProfiles();
            scheduleHideGhostBios();
            return UserProfileStore.getUserProfile(userId);
        } catch {
            return UserProfileStore.getUserProfile(userId);
        } finally {
            inFlight.delete(userId);
        }
    })();

    inFlight.set(userId, pending);
    return pending;
}

function pollVisible() {
    for (const id of visibleIds) {
        void refreshUserProfile(id).catch(() => undefined);
    }
}

function syncPoll() {
    if (visibleIds.size === 0) {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        return;
    }
    if (!pollTimer) pollTimer = setInterval(pollVisible, POLL_MS);
}

function setVisible(next: Set<string>) {
    const added: string[] = [];
    for (const id of next) {
        if (!visibleIds.has(id)) added.push(id);
    }
    visibleIds = next;
    syncPoll();
    for (const id of added) void refreshUserProfile(id, true).catch(() => undefined);
}

function watchGhostBios() {
    bioObserver?.disconnect();
    bioObserver = null;
    const roots = profileRoots();
    if (!roots.length) return;
    bioObserver = new MutationObserver(() => scheduleHideGhostBios());
    for (const root of roots) {
        bioObserver.observe(root, { childList: true, subtree: true });
    }
}

function scanOpenProfiles() {
    setVisible(scanVisibleIds());
    watchGhostBios();
    scheduleHideGhostBios();
}

function onModalOpen(event: { userId?: string; }) {
    const id = event?.userId && String(event.userId);
    if (!id) return;
    noteOpenProfile(id);
    scheduleHideGhostBios();
}

function onDiscordProfileSuccess(event: { userProfile?: { user?: { id?: string; }; user_id?: string; userId?: string; }; }) {
    const id = String(
        event?.userProfile?.user?.id
        ?? event?.userProfile?.user_id
        ?? event?.userProfile?.userId
        ?? ""
    );
    if (!id) return;
    lastFetchAt.set(id, Date.now());
    bumpProfiles();
    scheduleHideGhostBios();
}

function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(() => {
        scanTimer = 0;
        scanOpenProfiles();
    }, SCAN_MS);
}

function onProfileMutation(records: MutationRecord[]) {
    for (const rec of records) {
        for (const node of rec.addedNodes) {
            if (node instanceof HTMLElement && PROFILE_OPEN_RE.test(node.className)) {
                scheduleScan();
                return;
            }
        }
        for (const node of rec.removedNodes) {
            if (node instanceof HTMLElement && PROFILE_OPEN_RE.test(node.className)) {
                scheduleScan();
                return;
            }
        }
    }
}

export function noteOpenProfile(userId: string | null | undefined) {
    if (!userId) return;
    const id = String(userId);
    if (visibleIds.has(id)) return;
    const next = new Set(visibleIds);
    next.add(id);
    setVisible(next);
}

/** Writes hidden share tags into About Me so other Vencord clients can decode badges. */
export async function patchOwnBio(mutate: (bio: string) => string) {
    let release!: () => void;
    const previous = bioWriteChain;
    bioWriteChain = new Promise<void>(resolve => {
        release = resolve;
    });
    await previous;
    try {
        const userId = UserStore.getCurrentUser()?.id;
        if (!userId) return;
        let profile = UserProfileStore.getUserProfile(userId);
        const fetchedAt = lastFetchAt.get(userId) ?? 0;
        if (!profile || Date.now() - fetchedAt > 1500) {
            profile = await refreshUserProfile(userId, true).catch(() => profile);
        }
        const bio = profile?.bio ?? "";
        const next = mutate(bio);
        if (next === bio) return;
        await RestAPI.patch({
            url: "/users/@me/profile",
            body: { bio: next }
        });
        await refreshUserProfile(userId, true).catch(() => undefined);
        bumpProfiles();
        scheduleHideGhostBios();
    } finally {
        release();
    }
}

export function createShareSync(sync: () => Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queued = false;
    let running = false;

    const run = () => {
        if (running) {
            queued = true;
            return;
        }
        running = true;
        void (async () => {
            try {
                await sync();
            } finally {
                running = false;
                if (queued) {
                    queued = false;
                    run();
                }
            }
        })();
    };

    return () => {
        clearTimeout(timer);
        timer = setTimeout(run, WRITE_MS);
    };
}

let ownBadgeShare: ShareState | null = null;
let ownButtonShare: ButtonShare | null = null;

function bumpProfiles() {
    try { (UserStore as { emitChange?: () => void; }).emitChange?.(); } catch { /* ignore */ }
    try { (UserProfileStore as { emitChange?: () => void; }).emitChange?.(); } catch { /* ignore */ }
}

export function setOwnBadgeShare(state: ShareState | null) {
    ownBadgeShare = state;
    bumpProfiles();
}

export function getOwnBadgeShare() {
    return ownBadgeShare;
}

export function setOwnButtonShare(state: ButtonShare | null) {
    ownButtonShare = state;
    bumpProfiles();
}

export function getOwnButtonShare() {
    return ownButtonShare;
}

export function startLiveShare() {
    refs++;
    if (refs > 1) return;
    FluxDispatcher.subscribe("USER_PROFILE_MODAL_OPEN", onModalOpen);
    FluxDispatcher.subscribe("USER_PROFILE_FETCH_SUCCESS", onDiscordProfileSuccess);
    scanOpenProfiles();
    openObserver = new MutationObserver(onProfileMutation);
    openObserver.observe(document.body, { childList: true, subtree: true });
}

export function stopLiveShare() {
    refs = Math.max(0, refs - 1);
    if (refs > 0) return;
    FluxDispatcher.unsubscribe("USER_PROFILE_MODAL_OPEN", onModalOpen);
    FluxDispatcher.unsubscribe("USER_PROFILE_FETCH_SUCCESS", onDiscordProfileSuccess);
    openObserver?.disconnect();
    openObserver = null;
    if (scanTimer) {
        clearTimeout(scanTimer);
        scanTimer = 0;
    }
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = 0;
    bioObserver?.disconnect();
    bioObserver = null;
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    visibleIds = new Set();
    inFlight.clear();
}
