/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Heading } from "@components/Heading";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { GuildMemberStore, MessageStore, Text, TextInput, UserStore } from "@webpack/common";

import { Delexo } from "../_delexo/author";
import managedStyle from "./style.css?managed";

const MAX_LEN = 32;
const SNOWFLAKE = /^\d{16,22}$/;
const SKIP = [
    "input",
    "textarea",
    "select",
    "code",
    "pre",
    "script",
    "style",
    "[contenteditable='true']",
    ".vc-nickname-panel",
    ".vc-profile-button-host",
    "[id^='message-content-']",
    "[class*='messageContent']",
    "[class*='repliedTextContent']",
    "[class*='embedDescription']"
].join(", ");

const cl = classNameFactory("vc-nickname-");

type NameKind = "display" | "handle";

const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: SettingsPanel
    },
    displayName: {
        type: OptionType.STRING,
        description: "Replaces your display name everywhere.",
        default: "You",
        hidden: true,
        onChange() { applyLive(); }
    },
    handle: {
        type: OptionType.STRING,
        description: "Replaces your username everywhere.",
        default: "You",
        hidden: true,
        onChange() { applyLive(); }
    }
});

type RealNames = { username: string; globalName: string; };

const hooked = new WeakSet<object>();
const hookedUsers: any[] = [];
const realByUser = new WeakMap<object, RealNames>();
const originalText = new WeakMap<Text, string>();
const touched = new Set<Text>();

let running = false;
let real: RealNames = { username: "", globalName: "" };
let observer: MutationObserver | null = null;
let applying = false;
let liveRaf = 0;
let origGetUser: ((id: string) => any) | null = null;
let origGetCurrentUser: (() => any) | null = null;
let origGetNick: ((guildId: string, userId: string) => string | null) | null = null;

function desired(kind: NameKind) {
    if (!running) return "";
    const raw = kind === "display" ? settings.store.displayName : settings.store.handle;
    return String(raw ?? "").trim().slice(0, MAX_LEN);
}

function setDesired(kind: NameKind, value: string) {
    const next = String(value ?? "").slice(0, MAX_LEN);
    if (kind === "display") settings.store.displayName = next;
    else settings.store.handle = next;
    applyLive();
}

function sameName(a: string, b: string) {
    return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function isHandleToken(token: string) {
    const inner = token.trim();
    if (!inner) return false;
    const bare = inner.replace(/^@/, "");
    return sameName(bare, real.username) || sameName(bare, desired("handle"));
}

function isDisplayToken(token: string) {
    const inner = token.trim();
    if (!inner || inner.startsWith("@")) return false;
    return sameName(inner, real.globalName) || sameName(inner, desired("display"));
}

function isNameCandidate(text: string) {
    const inner = text.trim();
    if (!inner || inner.length > MAX_LEN + 1) return false;
    return isHandleToken(inner) || isDisplayToken(inner);
}

function paintExact(text: string) {
    const lead = text.match(/^\s*/)?.[0] ?? "";
    const trail = text.match(/\s*$/)?.[0] ?? "";
    const inner = text.slice(lead.length, text.length - trail.length);
    if (!inner) return text;

    const display = desired("display");
    const handle = desired("handle");
    if (inner.startsWith("@")) {
        return lead + (handle ? `@${handle}` : inner) + trail;
    }
    if (real.globalName && sameName(inner, real.globalName)) {
        return lead + (display || inner) + trail;
    }
    if (real.username && sameName(inner, real.username)) {
        return lead + (handle || inner) + trail;
    }
    if (display && sameName(inner, display)) return lead + display + trail;
    if (handle && sameName(inner, handle)) return lead + handle + trail;
    return text;
}

function skipNode(node: Node | null) {
    if (!node) return true;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el) return true;
    if (el.closest(SKIP)) return true;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "CODE" || tag === "PRE" || tag === "SCRIPT" || tag === "STYLE";
}

function attrUserId(el: Element): string | null {
    for (const name of ["data-user-id", "data-userid", "data-author-id"]) {
        const value = el.getAttribute(name);
        if (value && SNOWFLAKE.test(value)) return value;
    }
    const listId = el.getAttribute("data-list-item-id") || "";
    const member = listId.match(/members-(\d{16,22})/);
    if (member) return member[1];
    const href = el.getAttribute("href") || "";
    const userHref = href.match(/\/users\/(\d{16,22})/);
    if (userHref) return userHref[1];
    return null;
}

function fiberUserId(el: Element): string | null {
    const fiberKey = Object.keys(el).find(k =>
        k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    let fiber: any = fiberKey ? (el as any)[fiberKey] : null;
    for (let depth = 0; depth < 30 && fiber; depth++, fiber = fiber.return) {
        const p = fiber.memoizedProps || fiber.pendingProps || {};
        const user = p.user ?? p.message?.author ?? p.participant?.user;
        if (user?.id && SNOWFLAKE.test(String(user.id))) return String(user.id);
        if (p.userId && SNOWFLAKE.test(String(p.userId))) return String(p.userId);
        if (p.authorId && SNOWFLAKE.test(String(p.authorId))) return String(p.authorId);
        if (typeof p.id === "string" && SNOWFLAKE.test(p.id) && (p.username || p.globalName)) return p.id;
    }
    return null;
}

function ownerUserId(node: Node): string | null {
    const start = node instanceof Element ? node : node.parentElement;
    if (!start) return null;
    let cur: Element | null = start;
    for (let i = 0; i < 40 && cur; i++, cur = cur.parentElement) {
        const id = attrUserId(cur) ?? fiberUserId(cur);
        if (id) return id;
    }
    return null;
}

function isOwnUserNode(node: Node) {
    const me = String(ownId() ?? "");
    if (!me) return false;
    return ownerUserId(node) === me;
}

function forgetNode(node: Text) {
    originalText.delete(node);
    touched.delete(node);
}

function rewriteText(node: Text) {
    if (skipNode(node)) return;
    const current = node.nodeValue ?? "";
    const stored = originalText.get(node);
    if (!isNameCandidate(current) && !(stored != null && isNameCandidate(stored))) return;
    if (!isOwnUserNode(node)) {
        forgetNode(node);
        return;
    }

    const paintedStored = stored != null ? paintExact(stored) : "";
    const base = stored != null && (current === stored || current === paintedStored)
        ? stored
        : current;
    originalText.set(node, base);
    touched.add(node);
    const next = paintExact(base);
    if (node.nodeValue !== next) node.nodeValue = next;
}

function walk(root: Node | null) {
    if (!root || skipNode(root)) return;
    if (root.nodeType === Node.TEXT_NODE) {
        rewriteText(root as Text);
        return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return skipNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
    });
    const nodes: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) nodes.push(current as Text);
    for (const node of nodes) rewriteText(node);
}

function pruneTouched() {
    for (const node of [...touched]) {
        if (!node.isConnected) {
            touched.delete(node);
            originalText.delete(node);
        }
    }
}

function restoreTouched() {
    applying = true;
    try {
        for (const node of [...touched]) {
            if (!isOwnUserNode(node)) {
                forgetNode(node);
                continue;
            }
            const orig = originalText.get(node);
            if (orig != null && node.nodeValue !== orig) node.nodeValue = orig;
        }
    } finally {
        applying = false;
    }
}

function scanAll() {
    if (!running) return;
    pruneTouched();
    applying = true;
    observer?.disconnect();
    try {
        for (const node of [...touched]) {
            if (!isOwnUserNode(node)) forgetNode(node);
        }
        walk(document.body);
    } finally {
        applying = false;
        startObserver();
    }
}

function scanNodes(nodes: Iterable<Node>) {
    if (!running) return;
    applying = true;
    observer?.disconnect();
    try {
        for (const node of nodes) walk(node);
    } finally {
        applying = false;
        startObserver();
    }
}

function refreshUsers() {
    try { (UserStore as { emitChange?: () => void; }).emitChange?.(); } catch { /* ignore */ }
    try { (MessageStore as { emitChange?: () => void; }).emitChange?.(); } catch { /* ignore */ }
    try { (GuildMemberStore as { emitChange?: () => void; }).emitChange?.(); } catch { /* ignore */ }
}

function applyLive() {
    if (!running) return;
    if (liveRaf) cancelAnimationFrame(liveRaf);
    refreshUsers();
    liveRaf = requestAnimationFrame(() => {
        liveRaf = 0;
        if (!running) return;
        try { scanAll(); } catch { /* ignore */ }
        refreshUsers();
    });
}

let pending: Node[] = [];
let pendingTimer = 0;

function queueNodes(nodes: Node[]) {
    pending.push(...nodes);
    if (pendingTimer) return;
    pendingTimer = window.setTimeout(() => {
        pendingTimer = 0;
        const batch = pending;
        pending = [];
        try { scanNodes(batch); } catch { /* ignore */ }
    }, 40);
}

function startObserver() {
    observer?.disconnect();
    if (!running) return;
    observer = new MutationObserver(records => {
        if (applying) return;
        const nodes: Node[] = [];
        for (const rec of records) {
            if (rec.type === "characterData") {
                const text = rec.target.nodeValue ?? "";
                if (text.length > MAX_LEN + 12) continue;
                if (
                    real.username && !text.includes(real.username) &&
                    real.globalName && !text.includes(real.globalName)
                ) continue;
                const parent = rec.target.parentNode;
                if (parent && !skipNode(parent)) nodes.push(parent);
                continue;
            }
            for (const node of rec.addedNodes) {
                if (!skipNode(node)) nodes.push(node);
            }
        }
        if (nodes.length) queueNodes(nodes);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function ownId() {
    return origGetCurrentUser ? origGetCurrentUser()?.id : UserStore.getCurrentUser()?.id;
}

function isOwnUser(user: any) {
    const me = ownId();
    return Boolean(me && user && String(user.id) === String(me));
}

function hookUser(user: any) {
    if (!running || !isOwnUser(user)) return;
    if (hooked.has(user)) return;

    const box: RealNames = {
        username: String(user.username ?? ""),
        globalName: String(user.globalName ?? "")
    };
    if (box.username) real.username = box.username;
    if (box.globalName) real.globalName = box.globalName;
    realByUser.set(user, box);
    hooked.add(user);
    hookedUsers.push(user);

    try {
        Object.defineProperty(user, "username", {
            configurable: true,
            enumerable: true,
            get() { return (running && desired("handle")) || box.username; },
            set(value: string) {
                const v = String(value ?? "");
                if (!v || v === desired("handle")) return;
                box.username = v;
                real.username = v;
            }
        });
        Object.defineProperty(user, "globalName", {
            configurable: true,
            enumerable: true,
            get() { return (running && desired("display")) || box.globalName || null; },
            set(value: string) {
                const v = String(value ?? "");
                if (!v || v === desired("display")) return;
                box.globalName = v;
                real.globalName = v;
            }
        });
    } catch {
        // some user records are frozen
    }
}

function unhookUser(user: any) {
    const box = realByUser.get(user);
    if (!box) return;
    try {
        Object.defineProperty(user, "username", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: box.username
        });
        Object.defineProperty(user, "globalName", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: box.globalName || null
        });
    } catch {
        try {
            user.username = box.username;
            user.globalName = box.globalName || null;
        } catch { /* ignore */ }
    }
    hooked.delete(user);
    realByUser.delete(user);
}

function unhookAll() {
    for (const user of hookedUsers) unhookUser(user);
    hookedUsers.length = 0;
}

function patchStores() {
    origGetUser = UserStore.getUser.bind(UserStore);
    origGetCurrentUser = UserStore.getCurrentUser.bind(UserStore);
    origGetNick = GuildMemberStore.getNick.bind(GuildMemberStore);
    UserStore.getUser = ((id: string) => {
        const user = origGetUser!(id);
        if (isOwnUser(user)) hookUser(user);
        return user;
    }) as typeof UserStore.getUser;
    UserStore.getCurrentUser = (() => {
        const user = origGetCurrentUser!();
        hookUser(user);
        return user;
    }) as typeof UserStore.getCurrentUser;
    GuildMemberStore.getNick = ((guildId: string, userId: string) => {
        const nick = origGetNick!(guildId, userId);
        if (!running || String(userId) !== String(ownId() ?? "")) return nick;
        return desired("display") || nick;
    }) as typeof GuildMemberStore.getNick;
}

function unpatchStores() {
    if (origGetUser) UserStore.getUser = origGetUser as typeof UserStore.getUser;
    if (origGetCurrentUser) UserStore.getCurrentUser = origGetCurrentUser as typeof UserStore.getCurrentUser;
    if (origGetNick) GuildMemberStore.getNick = origGetNick as typeof GuildMemberStore.getNick;
    origGetUser = null;
    origGetCurrentUser = null;
    origGetNick = null;
}

function SettingsPanel() {
    settings.use(["displayName", "handle"] as never);
    return (
        <div className={cl("panel")}>
            <Text variant="text-sm/normal" className={cl("lede")}>
                Only your account is renamed. Names update as you type. Leave a field empty to keep the real one.
            </Text>
            <div className={cl("field")}>
                <Heading tag="h5">Display name</Heading>
                <TextInput
                    placeholder="You"
                    value={String(settings.store.displayName ?? "")}
                    maxLength={MAX_LEN}
                    onChange={value => setDesired("display", value)}
                />
            </div>
            <div className={cl("field")}>
                <Heading tag="h5">Username</Heading>
                <TextInput
                    placeholder="You"
                    value={String(settings.store.handle ?? "")}
                    maxLength={MAX_LEN}
                    onChange={value => setDesired("handle", value)}
                />
            </div>
        </div>
    );
}

export default definePlugin({
    name: "Nickname",
    description: "Replace your display name and username everywhere in Discord. Updates live as you type.",
    authors: [Delexo],
    tags: ["Appearance", "Fun"],
    searchTerms: ["handle", "username", "display name", "you", "profile"],
    requiresRestart: false,
    settings,
    managedStyle,

    start() {
        running = true;
        patchStores();
        hookUser(origGetCurrentUser?.() ?? UserStore.getCurrentUser());
        startObserver();
        applyLive();
    },

    stop() {
        running = false;
        if (liveRaf) cancelAnimationFrame(liveRaf);
        liveRaf = 0;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = 0;
        observer?.disconnect();
        observer = null;
        unhookAll();
        unpatchStores();
        restoreTouched();
        touched.clear();
        refreshUsers();
        requestAnimationFrame(() => {
            restoreTouched();
            refreshUsers();
        });
    }
});
