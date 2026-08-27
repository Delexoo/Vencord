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

const PROFILE_ROOT = [
    '[class*="userProfileModal"]',
    '[class*="userPopoutOuter"]',
    '[class*="userProfileOuter"]'
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

function norm(el: Element | null) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function ownUser() {
    return UserStore.getCurrentUser();
}

function findUserIdNear(el: Element | null): string | null {
    let cur: Element | null = el;
    for (let i = 0; i < 50 && cur; i++) {
        const fiberKey = Object.keys(cur).find(k =>
            k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
        );
        let fiber: any = fiberKey ? (cur as any)[fiberKey] : null;
        for (let d = 0; d < 40 && fiber; d++, fiber = fiber.return) {
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

function findOwnProfileRoot(): HTMLElement | null {
    const me = ownUser()?.id;
    if (!me) return null;

    const nodes = document.querySelectorAll<HTMLElement>(PROFILE_ROOT);
    let popout: HTMLElement | null = null;
    for (const el of nodes) {
        if (isNestedProfile(el)) continue;
        if (findUserIdNear(el) !== me) continue;
        if (el.matches('[class*="userProfileModal"]')) return el;
        popout = el;
    }
    return popout;
}

function tabKey(root: HTMLElement) {
    const selected =
        root.querySelector('[role="tab"][aria-selected="true"]') ||
        root.querySelector('[class*="tabBar"] [class*="selected"]') ||
        root.querySelector('[class*="item"][aria-selected="true"]');
    const key = norm(selected);
    return key || "default";
}

function originalHandle() {
    return ownUser()?.username ?? "";
}

function looksLikeHandle(text: string, username: string) {
    const t = text.replace(/^@/, "").toLowerCase();
    return t === username.toLowerCase();
}

function inHeader(root: HTMLElement, el: HTMLElement) {
    const rr = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top < rr.top + Math.min(280, rr.height * 0.5);
}

function isHandleCandidate(el: HTMLElement, username: string) {
    if (el.closest("#vc-last-online-profile-host, .vc-profile-button-host")) return false;
    if (/^(h1|h2|h3)$/i.test(el.tagName)) return false;
    if (el.querySelector("input")) return true;
    const t = norm(el);
    if (!t || t.length > 40) return false;
    if (!(looksLikeHandle(t, username) || (override != null && t === override))) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 10 && r.height <= 32;
}

function findHandle(root: HTMLElement): HTMLElement | null {
    const username = originalHandle();
    if (!username) return null;

    const preferred = root.querySelectorAll<HTMLElement>(
        '[class*="userTagUsername"], [class*="userNameTag"] span, [class*="nameTag"] span, [class*="userTag"] span, [class*="userTag"]'
    );
    for (const el of preferred) {
        if (!inHeader(root, el) || !isHandleCandidate(el, username)) continue;
        const parent = el.parentElement;
        if (parent && /userTag|nameTag|handle/i.test(parent.className)) {
            const t = norm(parent);
            if (looksLikeHandle(t, username) || t === `@${username}` || (override != null && t === override))
                return parent;
        }
        return el;
    }

    const all = root.querySelectorAll<HTMLElement>("span, div");
    for (const el of all) {
        if (el.querySelector("input, span, div")) continue;
        if (!inHeader(root, el) || !isHandleCandidate(el, username)) continue;
        return el;
    }

    return null;
}

function displayedHandle() {
    if (editing) return draft;
    if (override != null) return override;
    return originalHandle();
}

function sizeInput(input: HTMLInputElement) {
    const len = Math.max(displayedHandle().length, 4);
    input.style.width = `${len + 1}ch`;
}

function currentInput(el: HTMLElement) {
    return el.querySelector<HTMLInputElement>("input.vc-nickname-input");
}

function stopEdit(el: HTMLElement, next: string | null) {
    editing = false;
    draft = "";
    override = next && next.trim() ? next.slice(0, MAX_LEN) : null;
    el.classList.remove(cl("editing"));
    applyText(el);
}

function beginEdit(el: HTMLElement) {
    if (currentInput(el)) {
        currentInput(el)!.focus();
        currentInput(el)!.select();
        return;
    }

    editing = true;
    if (!draft) draft = override ?? originalHandle();

    const input = document.createElement("input");
    input.type = "text";
    input.className = cl("input");
    input.maxLength = MAX_LEN;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = draft;
    input.setAttribute("aria-label", "Preview nickname");
    sizeInput(input);

    input.addEventListener("input", () => {
        draft = input.value;
        sizeInput(input);
    });
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            stopEdit(el, input.value);
        } else if (e.key === "Escape") {
            e.preventDefault();
            stopEdit(el, override);
        }
    });
    input.addEventListener("click", e => e.stopPropagation());
    input.addEventListener("mousedown", e => e.stopPropagation());
    input.addEventListener("blur", () => {
        if (editing && currentInput(el) === input) stopEdit(el, input.value);
    });

    el.classList.add(cl("editing"));
    el.replaceChildren(input);
    input.focus();
    input.select();
}

function onHandleClick(e: Event) {
    const el = e.currentTarget as HTMLElement;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    beginEdit(el);
}

function onHandleMouseDown(e: Event) {
    e.stopPropagation();
    e.stopImmediatePropagation();
}

function applyText(el: HTMLElement) {
    if (editing && currentInput(el)) return;
    const next = override != null ? override : originalHandle();
    if (currentInput(el) || override != null) {
        if (norm(el) !== next) el.textContent = next;
    }
}

function restoreOriginal(el: HTMLElement | null) {
    if (!el) return;
    el.classList.remove(cl("editing"));
    if (currentInput(el) || override != null || editing) el.textContent = originalHandle();
}

function unwire() {
    if (!wired) return;
    wired.removeEventListener("click", onHandleClick, true);
    wired.removeEventListener("mousedown", onHandleMouseDown, true);
    wired.classList.remove(cl("handle"), cl("editing"));
    wired.removeAttribute(MARK);
    if (currentInput(wired) || override != null)
        wired.textContent = originalHandle();
    wired = null;
}

function wire(el: HTMLElement) {
    if (wired !== el || el.getAttribute(MARK) !== "1") {
        unwire();
        wired = el;
        el.setAttribute(MARK, "1");
        el.classList.add(cl("handle"));
        el.title = "Click to preview a nickname";
        el.addEventListener("click", onHandleClick, true);
        el.addEventListener("mousedown", onHandleMouseDown, true);
    }

    if (editing && !currentInput(el)) beginEdit(el);
    else applyText(el);
}

function resetSession() {
    restoreOriginal(wired);
    editing = false;
    draft = "";
    override = null;
    sessionRoot = null;
    sessionTab = "";
    unwire();
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
    description: "Click your handle on your own profile to preview a nickname. Visual only — it resets when you leave or switch tabs.",
    authors: [Delexo],
    tags: ["Appearance", "Fun"],
    searchTerms: ["handle", "username", "display name", "preview", "profile"],
    requiresRestart: false,
    managedStyle,

    start() {
        observer = new MutationObserver(() => queueTick());
        observer.observe(document.body, { childList: true, subtree: true });
        queueTick();
    },

    stop() {
        observer?.disconnect();
        observer = null;
        resetSession();
    }
});
