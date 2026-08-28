/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BadgePosition, BadgeUserArgs, ProfileBadge } from "@api/Badges";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heart } from "@components/Heart";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { fetchUserProfile } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import type { User } from "@vencord/discord-types";
import { Button, createRoot, RestAPI, UserProfileStore, UserStore, useEffect, useStateFromStores } from "@webpack/common";
import type { Root } from "react-dom/client";

import { Delexo } from "../_delexo/author";
import {
    decodeShare,
    isHttpUrl,
    writeShare,
    type ButtonShare,
} from "./share";
import managedStyle from "./style.css?managed";

const cl = classNameFactory("vc-profile-button-");

const REGISTRY_URL = "https://raw.githubusercontent.com/Delexoo/Vencord/main/src/userplugins/profileButton/registry.json";

const settings = definePluginSettings({
    label: {
        type: OptionType.STRING,
        description: "Button name on your profile",
        default: "Donate",
        placeholder: "Donate",
        onChange() { scheduleShare(); }
    },
    url: {
        type: OptionType.STRING,
        description: "Link opened when someone clicks the button",
        default: "",
        placeholder: "https://buy.stripe.com/...",
        isValid(value: string) {
            if (!value.trim()) return true;
            return isHttpUrl(value) || "Must be a valid http(s) URL.";
        },
        onChange() { scheduleShare(); }
    },
    showHeart: {
        type: OptionType.BOOLEAN,
        description: "Show a heart next to the button name",
        default: true,
        onChange() { scheduleShare(); }
    }
});

let registry: Record<string, ButtonShare> = {};

function ownId() {
    return UserStore.getCurrentUser()?.id;
}

function currentShare(): ButtonShare | null {
    const label = String(settings.store.label ?? "").trim();
    const url = String(settings.store.url ?? "").trim();
    if (!label || !isHttpUrl(url)) return null;
    return {
        label: label.slice(0, 32),
        url,
        heart: settings.store.showHeart !== false
    };
}

function registryShare(userId: string): ButtonShare | null {
    const item = registry[userId];
    if (!item) return null;
    const label = String(item.label ?? "").trim().slice(0, 32);
    const url = String(item.url ?? "").trim();
    if (!label || !isHttpUrl(url)) return null;
    return { label, url, heart: item.heart !== false };
}

function shareFor(userId: string): ButtonShare | null {
    if (userId === ownId()) return currentShare() ?? registryShare(userId);
    return decodeShare(UserProfileStore.getUserProfile(userId)?.bio) ?? registryShare(userId);
}

async function loadRegistry() {
    try {
        const res = await fetch(REGISTRY_URL, { cache: "no-cache" });
        if (!res.ok) return;
        const data = await res.json();
        if (!data || typeof data !== "object") return;
        const next: Record<string, ButtonShare> = {};
        for (const [id, value] of Object.entries(data as Record<string, ButtonShare>)) {
            const label = String(value?.label ?? "").trim().slice(0, 32);
            const url = String(value?.url ?? "").trim();
            if (!label || !isHttpUrl(url)) continue;
            next[id] = { label, url, heart: value.heart !== false };
        }
        registry = next;
    } catch {
        // ignore
    }
}

async function syncShareToBio() {
    const userId = ownId();
    if (!userId) return;
    try {
        let profile = UserProfileStore.getUserProfile(userId);
        if (!profile) profile = await fetchUserProfile(userId);
        const next = writeShare(profile?.bio ?? "", currentShare());
        if (next === (profile?.bio ?? "")) return;
        await RestAPI.patch({
            url: "/users/@me/profile",
            body: { bio: next }
        });
    } catch (e) {
        console.error("[ProfileButton] failed to save profile button share", e);
    }
}

const scheduleShare = debounce(() => {
    void syncShareToBio();
}, 800);

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

function profileRoots() {
    const nodes = document.querySelectorAll<HTMLElement>([
        '[class*="userProfileModal"]',
        '[class*="userProfileOuter"]',
        '[class*="userProfileInner"]',
        '[class*="userPopoutOuter"]',
        '[class*="userPopoutInner"]',
        '[class*="biteSize"]',
    ].join(","));
    return [...nodes];
}

function actionLabel(el: HTMLElement) {
    return [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.textContent,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function isActionAnchor(el: HTMLElement) {
    if (el.closest("#vc-profile-button-popout-host, #vc-profile-button-modal-host, .vc-profile-button-slot"))
        return false;
    const t = actionLabel(el);
    return /^(message|send message|send a message|edit profile|view full profile)\b/i.test(t)
        || /^(message|send message|edit profile|view full profile)$/i.test(t);
}

function findActionAnchor(): HTMLElement | null {
    const roots = profileRoots();
    const scopes = roots.length ? roots : [document.body];
    for (const root of scopes) {
        const nodes = root.querySelectorAll<HTMLElement>("button, [role='button']");
        for (const el of nodes) {
            if (isActionAnchor(el)) return el;
        }
    }
    return null;
}

function findButtonRow(anchor: HTMLElement): HTMLElement {
    return (
        anchor.closest<HTMLElement>('[class*="buttons"]') ||
        anchor.closest<HTMLElement>('[class*="buttonContainer"]') ||
        anchor.parentElement ||
        anchor
    );
}

function slotInRow(anchor: HTMLElement, row: HTMLElement): HTMLElement {
    if (anchor === row) return anchor;
    let cur: HTMLElement = anchor;
    while (cur.parentElement && cur.parentElement !== row)
        cur = cur.parentElement;
    return cur;
}

function isFullProfile(el: HTMLElement) {
    return Boolean(el.closest('[class*="userProfileModal"]'));
}

const ProfileLinkButton = ErrorBoundary.wrap(function ProfileLinkButton({ userId }: { userId: string; }) {
    settings.use(["label", "url", "showHeart"]);
    const profile = useStateFromStores(
        [UserProfileStore],
        () => UserProfileStore.getUserProfile(userId)
    );

    useEffect(() => {
        void fetchUserProfile(userId).catch(() => undefined);
    }, [userId]);

    const data = userId === ownId()
        ? currentShare() ?? registryShare(userId)
        : decodeShare(profile?.bio) ?? registryShare(userId);

    if (!data) return null;

    return (
        <div className={cl("wrap")}>
            <Button
                className={cl("btn")}
                color={Button.Colors.CUSTOM}
                look={Button.Looks.FILLED}
                size={Button.Sizes.NONE}
                onClick={() => VencordNative.native.openExternal(data.url)}
            >
                {data.label}
                {data.heart ? <Heart className={cl("heart")} /> : null}
            </Button>
        </div>
    );
}, { noop: true });

const ProfileButtonSlot = ErrorBoundary.wrap(function ProfileButtonSlot({ user }: { user: User; }) {
    if (!user?.id) return null;
    return (
        <div className={cl("slot")}>
            <ProfileLinkButton userId={user.id} />
        </div>
    );
}, { noop: true });

function DonateBadgeIcon() {
    return <Heart className={cl("badge-heart")} />;
}

function getBadges({ userId }: BadgeUserArgs): ProfileBadge[] {
    const data = shareFor(userId);
    if (!data) return [];
    return [{
        id: "delexo_profile_button",
        key: "delexo_profile_button",
        description: data.label,
        component: DonateBadgeIcon,
        position: BadgePosition.START,
        onClick() {
            VencordNative.native.openExternal(data.url);
        }
    }];
}

const profileBadge: ProfileBadge = {
    id: "delexo_profile_button_wrap",
    getBadges,
    position: BadgePosition.START
};

let popoutHost: HTMLDivElement | null = null;
let popoutRoot: Root | null = null;
let modalHost: HTMLDivElement | null = null;
let modalRoot: Root | null = null;
let observer: MutationObserver | null = null;
let queued = false;

function removeHost(kind: "popout" | "modal") {
    if (kind === "popout") {
        popoutRoot?.unmount();
        popoutRoot = null;
        popoutHost?.remove();
        popoutHost = null;
        return;
    }
    modalRoot?.unmount();
    modalRoot = null;
    modalHost?.remove();
    modalHost = null;
}

function placeButton() {
    queued = false;
    const anchor = findActionAnchor();
    if (!anchor) {
        if (popoutHost && !document.body.contains(popoutHost)) removeHost("popout");
        if (modalHost && !document.body.contains(modalHost)) removeHost("modal");
        return;
    }

    const userId = findUserIdNear(anchor);
    if (!userId) return;

    const row = findButtonRow(anchor);
    const slot = slotInRow(anchor, row);

    const modal = isFullProfile(anchor);
    const kind = modal ? "modal" : "popout";
    const hostId = modal ? "vc-profile-button-modal-host" : "vc-profile-button-popout-host";
    let host = modal ? modalHost : popoutHost;
    let root = modal ? modalRoot : popoutRoot;

    if (host?.isConnected && host.parentElement === row && host.previousElementSibling === slot && host.getAttribute("data-user-id") === userId)
        return;

    removeHost(kind);

    host = document.createElement("div");
    host.id = hostId;
    host.className = cl("host", modal && "host-modal");
    host.setAttribute("data-user-id", userId);

    const height = slot.getBoundingClientRect().height;
    if (height > 0) host.style.height = `${Math.round(height)}px`;

    if (slot.nextSibling)
        row.insertBefore(host, slot.nextSibling);
    else
        row.appendChild(host);

    root = createRoot(host);
    root.render(<ProfileLinkButton userId={userId} />);

    if (modal) {
        modalHost = host;
        modalRoot = root;
    } else {
        popoutHost = host;
        popoutRoot = root;
    }
}

function queuePlace() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
        try { placeButton(); } catch { queued = false; }
    });
}

export default definePlugin({
    name: "ProfileButton",
    description: "Add a custom button (name + link) on profiles. Every Vencord user with this plugin can see it.",
    authors: [Delexo],
    tags: ["Appearance"],
    searchTerms: ["donate", "button", "profile", "link", "kofi", "stripe", "paypal", "heart"],
    enabledByDefault: true,
    requiresRestart: false,
    dependencies: ["BadgeAPI"],
    settings,
    managedStyle,
    userProfileBadge: profileBadge,

    patches: [
        {
            find: ".SIDEBAR,disableToolbar:",
            replacement: {
                match: /user:(\i),widgets:.{0,100}?\}\),(?=.{0,100}unownedWishlistItems:\i,wishlistId:\i)/,
                replace: "$&$self.renderProfileButton({user:$1}),"
            },
            noWarn: true
        },
        {
            find: '"UserProfilePopout");',
            replacement: {
                match: /user:(\i),widgets:.{0,100}?\}\),/,
                replace: "$&$self.renderProfileButton({user:$1}),"
            },
            noWarn: true
        },
        {
            find: ".MODAL_V2,onClose:",
            replacement: {
                match: /user:(\i),widgets:.{0,100}?\}\),/,
                replace: "$&$self.renderProfileButton({user:$1}),"
            },
            noWarn: true
        }
    ],

    renderProfileButton: ProfileButtonSlot,

    start() {
        void loadRegistry();
        scheduleShare();
        queuePlace();
        observer = new MutationObserver(() => queuePlace());
        observer.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        observer?.disconnect();
        observer = null;
        removeHost("popout");
        removeHost("modal");
        void (async () => {
            const userId = ownId();
            if (!userId) return;
            try {
                let profile = UserProfileStore.getUserProfile(userId);
                if (!profile) profile = await fetchUserProfile(userId);
                const next = writeShare(profile?.bio ?? "", null);
                if (next === (profile?.bio ?? "")) return;
                await RestAPI.patch({
                    url: "/users/@me/profile",
                    body: { bio: next }
                });
            } catch { /* ignore */ }
        })();
    }
});
