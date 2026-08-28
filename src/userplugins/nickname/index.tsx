/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { UserStore } from "@webpack/common";

import { Delexo } from "../_delexo/author";
import managedStyle from "./style.css?managed";

const cl = classNameFactory("vc-nickname-");
const MARK = "data-vc-nickname";
const ORIG = "data-vc-nickname-orig";
const MAX_LEN = 32;
const SKIP = "#vc-last-online-profile-host, .vc-profile-button-host, input, textarea, [contenteditable='true']";

const PROFILE_ROOT = [
    '[class*="userProfileModal"]',
    '[class*="userProfileOuter"]',
    '[class*="userPopoutOuter"]',
    '[class*="userProfileInner"]',
    '[class*="profilePanel"]'
].join(", ");

const ACCOUNT_ROOT = 'section[class*="panels"]';

const NAME_SEL = [
    "h1",
    "h2",
    "h3",
    "[class*='nickname']",
    "[class*='displayName']",
    "[class*='userTagUsername']",
    "[class*='userTag']",
    "[class*='nameTag']",
    "[class*='username']",
    "[class*='handle']"
].join(", ");

type NameKind = "display" | "handle";

const settings = definePluginSettings({
    displayName: {
        type: OptionType.STRING,
        description: "Display name shown on your profile. Leave empty to keep your real display name.",
        default: "You",
        placeholder: "You",
        onChange() { namesCache = null; scheduleTick(); }
    },
    handle: {
        type: OptionType.STRING,
        description: "Handle shown on your profile. Leave empty to keep your real username.",
        default: "You",
        placeholder: "You",
        onChange() { namesCache = null; scheduleTick(); }
    }
});

let observer: MutationObserver | null = null;
let profileObserver: MutationObserver | null = null;
let watchedRoot: HTMLElement | null = null;
let applying = false;
let namesCache: Set<string> | null = null;

const PROFILE_OPEN_RE = /userProfileModal|userProfileOuter|userPopoutOuter|profilePanel/;

function norm(el: Element | null) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function stripAt(text: string) {
    return text.replace(/^@/, "").trim();
}

function ownUser() {
    return UserStore.getCurrentUser();
}

function desired(kind: NameKind) {
    const raw = kind === "display" ? settings.store.displayName : settings.store.handle;
    return String(raw ?? "").trim().slice(0, MAX_LEN);
}

function ownNames() {
    if (namesCache) return namesCache;
    const me = ownUser();
    const names = new Set<string>();
    if (me?.username) names.add(me.username);
    if (me?.globalName) names.add(me.globalName);
    const display = desired("display");
    const handle = desired("handle");
    if (display) names.add(display);
    if (handle) names.add(handle);
    namesCache = names;
    return names;
}

function isOwnLabel(text: string) {
    const t = stripAt(text);
    if (!t || t.length > 40) return false;
    const names = ownNames();
    if (names.has(t)) return true;
    const lower = t.toLowerCase();
    for (const name of names) {
        if (name.toLowerCase() === lower) return true;
    }
    return false;
}

function findUserIdNear(el: Element | null): string | null {
    let cur: Element | null = el;
    for (let i = 0; i < 50 && cur; i++) {
        const fiberKey = Object.keys(cur).find(k =>
            k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
        );
        let fiber: any = fiberKey ? (cur as any)[fiberKey] : null;
        for (let d = 0; d < 45 && fiber; d++, fiber = fiber.return) {
            const p = fiber.memoizedProps || fiber.pendingProps || {};
            if (p.user?.id) return String(p.user.id);
            if (p.userId) return String(p.userId);
            if (typeof p.id === "string" && /^\d{16,20}$/.test(p.id) && p.username) return p.id;
        }
        cur = cur.parentElement;
    }
    return null;
}

function isNestedProfile(el: HTMLElement) {
    const parent = el.parentElement?.closest(PROFILE_ROOT);
    return parent != null && parent !== el;
}

function isOwnRoot(el: HTMLElement) {
    const me = ownUser()?.id;
    if (!me) return false;
    const id = findUserIdNear(el);
    if (id === me) return true;
    if (id && id !== me) return false;
    return [...el.querySelectorAll<HTMLElement>(NAME_SEL)].some(node => isOwnLabel(norm(node)));
}

function collectRoots() {
    const out: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    const add = (el: HTMLElement | null) => {
        if (!el || seen.has(el) || !isOwnRoot(el)) return;
        seen.add(el);
        out.push(el);
    };

    for (const el of document.querySelectorAll<HTMLElement>(PROFILE_ROOT)) {
        if (isNestedProfile(el)) continue;
        add(el);
    }
    for (const el of document.querySelectorAll<HTMLElement>(ACCOUNT_ROOT)) add(el);
    return out;
}

function isJunk(text: string) {
    return /^(activity|mutual|message|note|member since|friends since|edit profile|view full profile|bio|pronouns)$/i.test(text);
}

function skipEl(el: HTMLElement) {
    if (el.closest(SKIP)) return true;
    if (/clanTag|guildTag|badge/i.test(el.className)) return true;
    return false;
}

function isLeafName(el: HTMLElement) {
    for (const child of el.querySelectorAll<HTMLElement>(NAME_SEL)) {
        if (child !== el && isOwnLabel(norm(child))) return false;
    }
    return true;
}

function classify(el: HTMLElement): NameKind | null {
    if (skipEl(el) || !isLeafName(el)) return null;
    const marked = el.getAttribute(MARK);
    if (marked === "display" || marked === "handle") return marked;
    const text = norm(el);
    if (!text || text.length > 40 || isJunk(text) || !isOwnLabel(text)) return null;

    const cls = `${el.className} ${el.parentElement?.className ?? ""}`;
    if (/userTagUsername|userTag|nameTag|handle/i.test(cls) || text.startsWith("@")) return "handle";
    if (/nickname|displayName/i.test(cls) || /^(h1|h2|h3)$/i.test(el.tagName)) return "display";
    if (/username/i.test(cls)) return "handle";
    return "display";
}

function score(el: HTMLElement, kind: NameKind) {
    let n = 1;
    const cls = el.className;
    if (kind === "display") {
        if (/^(h1|h2|h3)$/i.test(el.tagName)) n += 80;
        if (/nickname|displayName/i.test(cls)) n += 60;
    } else {
        if (/userTagUsername|userTag|nameTag|handle|username/i.test(cls)) n += 60;
        if (norm(el).startsWith("@")) n += 20;
    }
    return n;
}

function pick(root: HTMLElement, kind: NameKind, used: Set<HTMLElement>) {
    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const el of root.querySelectorAll<HTMLElement>(NAME_SEL)) {
        if (used.has(el) || classify(el) !== kind) continue;
        const n = score(el, kind);
        if (n > bestScore) {
            best = el;
            bestScore = n;
        }
    }
    return best;
}

function nextText(kind: NameKind, orig: string) {
    switch (kind) {
        case "display":
            return desired("display") || orig;
        case "handle": {
            const want = desired("handle");
            if (!want) return orig;
            return orig.trim().startsWith("@") ? `@${want}` : want;
        }
        default: {
            const _never: never = kind;
            return orig;
        }
    }
}

function apply(el: HTMLElement, kind: NameKind) {
    if (!el.hasAttribute(ORIG)) el.setAttribute(ORIG, el.textContent ?? "");
    const orig = el.getAttribute(ORIG) ?? "";
    const next = nextText(kind, orig);
    el.setAttribute(MARK, kind);
    el.classList.add(cl(kind));
    if ((el.textContent ?? "") !== next) el.textContent = next;
}

function alreadyApplied() {
    const marked = document.querySelectorAll<HTMLElement>(`[${MARK}]`);
    if (!marked.length) return false;
    for (const el of marked) {
        if (!el.isConnected) return false;
        const kind = el.getAttribute(MARK);
        if (kind !== "display" && kind !== "handle") return false;
        const orig = el.getAttribute(ORIG) ?? "";
        if ((el.textContent ?? "") !== nextText(kind, orig)) return false;
    }
    return true;
}

function watchProfileRoot(root: HTMLElement | null) {
    if (root === watchedRoot && profileObserver) return;
    profileObserver?.disconnect();
    profileObserver = null;
    watchedRoot = root;
    if (!root) return;
    profileObserver = new MutationObserver(records => {
        for (const rec of records) {
            if (rec.target instanceof Element && rec.target.closest(`[${MARK}], ${SKIP}`)) continue;
            scheduleTick();
            return;
        }
    });
    profileObserver.observe(root, { childList: true, subtree: true });
}

function tick() {
    if (applying) return;
    namesCache = null;
    if (alreadyApplied()) {
        if (!profileObserver) {
            const marked = document.querySelector<HTMLElement>(`[${MARK}]`);
            watchProfileRoot(
                marked?.closest<HTMLElement>(PROFILE_ROOT)
                ?? marked?.closest<HTMLElement>(ACCOUNT_ROOT)
                ?? null
            );
        }
        return;
    }
    applying = true;
    profileObserver?.disconnect();
    try {
        const used = new Set<HTMLElement>();
        let watch: HTMLElement | null = null;
        for (const root of collectRoots()) {
            watch = watch ?? root;
            const display = pick(root, "display", used);
            if (display) used.add(display);
            const handle = pick(root, "handle", used);
            if (handle) used.add(handle);
            if (display && handle && display !== handle) {
                apply(display, "display");
                apply(handle, "handle");
                continue;
            }
            const only = display || handle;
            if (!only) continue;
            if (desired("display")) apply(only, "display");
            else if (desired("handle")) apply(only, "handle");
        }
        watchProfileRoot(watch);
    } finally {
        applying = false;
        if (watchedRoot) watchProfileRoot(watchedRoot);
    }
}

const scheduleTick = debounce(() => {
    try { tick(); } catch { /* ignore */ }
}, 120);

function didOpenOrCloseProfile(records: MutationRecord[]) {
    for (const rec of records) {
        for (const node of rec.addedNodes) {
            if (node instanceof HTMLElement && PROFILE_OPEN_RE.test(node.className)) return true;
        }
        for (const node of rec.removedNodes) {
            if (node instanceof HTMLElement && PROFILE_OPEN_RE.test(node.className)) return true;
        }
    }
    return false;
}

function restore(el: HTMLElement) {
    const orig = el.getAttribute(ORIG);
    if (orig != null) el.textContent = orig;
    el.removeAttribute(MARK);
    el.removeAttribute(ORIG);
    el.classList.remove(cl("display"), cl("handle"));
}

function restoreAll() {
    for (const el of document.querySelectorAll<HTMLElement>(`[${MARK}]`)) restore(el);
}

export default definePlugin({
    name: "Nickname",
    description: "Replace your display name and handle on your own profile. Both optional; both default to You.",
    authors: [Delexo],
    tags: ["Appearance", "Fun"],
    searchTerms: ["handle", "username", "display name", "you", "profile"],
    requiresRestart: false,
    settings,
    managedStyle,

    start() {
        scheduleTick();
        observer = new MutationObserver(records => {
            if (didOpenOrCloseProfile(records)) scheduleTick();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        observer?.disconnect();
        observer = null;
        profileObserver?.disconnect();
        profileObserver = null;
        watchedRoot = null;
        restoreAll();
    }
});
