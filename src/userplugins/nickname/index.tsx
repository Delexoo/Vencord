/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import definePlugin from "@utils/types";
import { UserStore } from "@webpack/common";

import { Delexo } from "../_delexo/author";
import managedStyle from "./style.css?managed";

const cl = classNameFactory("vc-nickname-");
const MARK = "data-vc-nickname";
const MAX_LEN = 32;
const SKIP = "#vc-last-online-profile-host, .vc-profile-button-host, .vc-nickname-input";

const PROFILE_ROOT = [
    '[class*="userProfileModal"]',
    '[class*="userProfileOuter"]',
    '[class*="userPopoutOuter"]',
    '[class*="profilePanel"]',
    '[class*="fullSize"][class*="userProfile"]'
].join(", ");

let observer: MutationObserver | null = null;
let queued = false;
let applying = false;
let override: string | null = null;
let editing = false;
let draft = "";
let sessionRoot: HTMLElement | null = null;
let sessionTab = "";
let wired: HTMLElement | null = null;
let overlay: HTMLInputElement | null = null;
let overlayTarget: HTMLElement | null = null;

function norm(el: Element | null) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function ownUser() {
    return UserStore.getCurrentUser();
}

function ownNames() {
    const me = ownUser();
    if (!me) return [] as string[];
    const names = [me.username];
    if (me.globalName && me.globalName !== me.username) names.push(me.globalName);
    return names;
}

function matchesOwnName(text: string) {
    const t = text.replace(/^@/, "").trim();
    if (!t) return false;
    if (override != null && t === override) return true;
    if (draft && editing && t === draft) return true;
    return ownNames().some(n => n.toLowerCase() === t.toLowerCase());
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

function headingLooksOwn(el: HTMLElement) {
    const heading = el.querySelector<HTMLElement>("h1, h2, h3, [class*='nickname'], [class*='displayName']");
    return matchesOwnName(norm(heading));
}

function isOwnProfileRoot(el: HTMLElement) {
    const me = ownUser()?.id;
    if (!me) return false;
    const id = findUserIdNear(el);
    if (id === me) return true;
    if (id && id !== me) return false;
    return headingLooksOwn(el);
}

function findOwnProfileRoot(): HTMLElement | null {
    const nodes = document.querySelectorAll<HTMLElement>(PROFILE_ROOT);
    let popout: HTMLElement | null = null;
    for (const el of nodes) {
        if (isNestedProfile(el)) continue;
        if (!isOwnProfileRoot(el)) continue;
        if (el.matches('[class*="userProfileModal"], [class*="userProfileOuter"]')) return el;
        popout = el;
    }
    return popout;
}

function tabKey(root: HTMLElement) {
    const selected =
        root.querySelector('[role="tab"][aria-selected="true"]') ||
        root.querySelector('[class*="tabBar"] [class*="selected"]');
    return norm(selected) || "default";
}

function inHeader(root: HTMLElement, el: HTMLElement) {
    const rr = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12) return false;
    return r.top < rr.top + Math.max(320, rr.height * 0.55);
}

function isJunkName(text: string) {
    return /^(activity|mutual|message|note|member since|friends since|edit profile|view full profile|bio|pronouns)$/i.test(text);
}

function scoreNameEl(el: HTMLElement, root: HTMLElement) {
    if (el.closest(SKIP)) return -1;
    if (el.closest("button") && !/nickname|displayName|username|userTag|nameTag|handle/i.test(el.className + (el.parentElement?.className ?? ""))) {
        const t = norm(el);
        if (!matchesOwnName(t)) return -1;
    }
    const t = norm(el);
    if (!t || t.length > 40 || isJunkName(t) || !matchesOwnName(t)) return -1;
    if (!inHeader(root, el)) return -1;
    const r = el.getBoundingClientRect();
    let score = r.height + r.width / 20;
    if (/^(h1|h2|h3)$/i.test(el.tagName)) score += 80;
    if (/nickname|displayName/i.test(el.className)) score += 60;
    if (/userTagUsername|userTag|nameTag|handle|username/i.test(el.className)) score += 40;
    const kids = el.querySelectorAll("h1, h2, h3, span, div").length;
    if (kids > 8) score -= 40;
    return score;
}

function findHandle(root: HTMLElement): HTMLElement | null {
    const nodes = root.querySelectorAll<HTMLElement>(
        "h1, h2, h3, [class*='nickname'], [class*='displayName'], [class*='userTagUsername'], [class*='userTag'], [class*='nameTag'], [class*='username'], [class*='handle'], span, div"
    );
    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const el of nodes) {
        const score = scoreNameEl(el, root);
        if (score > bestScore) {
            best = el;
            bestScore = score;
        }
    }
    return best;
}

function originalName() {
    const me = ownUser();
    return me?.globalName || me?.username || "";
}

function placeOverlay() {
    if (!overlay || !overlayTarget) return;
    const r = overlayTarget.getBoundingClientRect();
    overlay.style.left = `${Math.round(r.left)}px`;
    overlay.style.top = `${Math.round(r.top)}px`;
    overlay.style.height = `${Math.max(16, Math.round(r.height))}px`;
    const len = Math.max(draft.length, overlay.value.length, 4);
    overlay.style.width = `${Math.max(Math.round(r.width), (len + 1) * 12)}px`;
}

function removeOverlay() {
    overlay?.remove();
    overlay = null;
    if (overlayTarget) overlayTarget.style.opacity = "";
    overlayTarget = null;
}

function applyText(el: HTMLElement) {
    if (editing) return;
    const next = override != null ? override : originalName();
    if (override != null && norm(el) !== next) el.textContent = next;
}

function stopEdit(next: string | null) {
    const target = overlayTarget;
    editing = false;
    draft = "";
    override = next && next.trim() ? next.slice(0, MAX_LEN) : null;
    removeOverlay();
    if (target) {
        target.classList.remove(cl("editing"));
        if (override != null) target.textContent = override;
        else target.textContent = originalName();
    }
}

function beginEdit(el: HTMLElement) {
    if (overlay && overlayTarget === el) {
        overlay.focus();
        overlay.select();
        return;
    }

    removeOverlay();
    editing = true;
    draft = override ?? (matchesOwnName(norm(el)) ? norm(el).replace(/^@/, "") : originalName());

    overlayTarget = el;
    el.classList.add(cl("editing"));
    el.style.opacity = "0";

    const cs = getComputedStyle(el);
    const input = document.createElement("input");
    input.type = "text";
    input.className = cl("input");
    input.maxLength = MAX_LEN;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = draft;
    input.setAttribute("aria-label", "Preview nickname");
    input.style.position = "fixed";
    input.style.zIndex = "1000000";
    input.style.fontFamily = cs.fontFamily;
    input.style.fontSize = cs.fontSize;
    input.style.fontWeight = cs.fontWeight;
    input.style.letterSpacing = cs.letterSpacing;
    input.style.lineHeight = cs.lineHeight;
    input.style.color = cs.color || "#fff";
    overlay = input;
    placeOverlay();

    input.addEventListener("input", () => {
        draft = input.value;
        placeOverlay();
    });
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            stopEdit(input.value);
        } else if (e.key === "Escape") {
            e.preventDefault();
            stopEdit(override);
        }
    });
    input.addEventListener("pointerdown", e => e.stopPropagation());
    input.addEventListener("click", e => e.stopPropagation());
    input.addEventListener("blur", () => {
        if (editing && overlay === input) stopEdit(input.value);
    });

    document.body.appendChild(input);
    input.focus();
    input.select();
}

function nameFromTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    if (target.closest(".vc-nickname-input")) return null;
    const marked = target.closest<HTMLElement>(`[${MARK}]`);
    if (marked) return marked;
    const root = findOwnProfileRoot();
    if (!root || !root.contains(target)) return null;
    let cur: HTMLElement | null = target as HTMLElement;
    for (let i = 0; i < 8 && cur && root.contains(cur); i++, cur = cur.parentElement) {
        if (scoreNameEl(cur, root) > 0) return cur;
    }
    return findHandle(root);
}

function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (editing) return;
    const nameEl = nameFromTarget(e.target);
    if (!nameEl) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    beginEdit(nameEl);
}

function restoreOriginal(el: HTMLElement | null) {
    if (!el) return;
    el.classList.remove(cl("editing"));
    el.style.opacity = "";
    if (override != null || editing) el.textContent = originalName();
}

function unwire() {
    if (!wired) return;
    wired.classList.remove(cl("handle"), cl("editing"));
    wired.removeAttribute(MARK);
    wired.style.opacity = "";
    wired = null;
}

function wire(el: HTMLElement) {
    if (wired !== el) {
        unwire();
        wired = el;
        el.setAttribute(MARK, "1");
        el.classList.add(cl("handle"));
        el.title = "Click to preview a nickname";
    }
    applyText(el);
}

function resetSession() {
    if (editing) stopEdit(null);
    restoreOriginal(wired);
    editing = false;
    draft = "";
    override = null;
    sessionRoot = null;
    sessionTab = "";
    unwire();
    removeOverlay();
}

function tick() {
    queued = false;
    if (applying) return;
    applying = true;
    try {
        const root = findOwnProfileRoot();
        if (!root) {
            resetSession();
            return;
        }

        if (sessionRoot !== root) {
            resetSession();
            sessionRoot = root;
            sessionTab = tabKey(root);
        } else {
            const tab = tabKey(root);
            if (tab !== sessionTab) {
                sessionTab = tab;
                if (editing) stopEdit(null);
                restoreOriginal(wired);
                override = null;
                editing = false;
                draft = "";
            }
        }

        sessionRoot = root;
        const handle = findHandle(root);
        if (!handle) return;
        wire(handle);
        if (editing) placeOverlay();
    } finally {
        applying = false;
    }
}

function queueTick() {
    if (queued || applying) return;
    queued = true;
    requestAnimationFrame(() => {
        try { tick(); } catch { queued = false; }
    });
}

export default definePlugin({
    name: "Nickname",
    description: "Click your name on your own profile to preview a nickname. Visual only — it resets when you leave or switch tabs.",
    authors: [Delexo],
    tags: ["Appearance", "Fun"],
    searchTerms: ["handle", "username", "display name", "preview", "profile"],
    requiresRestart: false,
    managedStyle,

    start() {
        observer = new MutationObserver(() => queueTick());
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        document.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("resize", placeOverlay);
        queueTick();
    },

    stop() {
        observer?.disconnect();
        observer = null;
        document.removeEventListener("pointerdown", onPointerDown, true);
        window.removeEventListener("resize", placeOverlay);
        resetSession();
    }
});
