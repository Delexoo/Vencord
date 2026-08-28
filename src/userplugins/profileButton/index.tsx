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
        '[class*="profilePanel"]',
        '[class*="biteSize"]',
    ].join(","));
    return [...nodes];
}

function isJunkName(text: string) {
    return /^(activity|mutual|message|note|member since|friends since|edit profile|view full profile|bio|pronouns)$/i.test(text);
}

function findNameInRoot(root: HTMLElement): HTMLElement | null {
    const nodes = root.querySelectorAll<HTMLElement>(
        "h1, h2, h3, [class*='nickname'], [class*='displayName']"
    );
    for (const el of nodes) {
        if (el.closest("#vc-profile-button-popout-host, #vc-profile-button-modal-host, #vc-last-online-profile-host, .vc-profile-button-host, .vc-nickname-input"))
            continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 40 || isJunkName(t)) continue;
        if (el.querySelector("h1, h2, h3, [class*='nickname'], [class*='displayName']")) continue;
        return el;
    }
    return null;
}

function profileKind(el: HTMLElement): "popout" | "modal" {
    return el.closest('[class*="userProfileModal"], [class*="profilePanel"]') ? "modal" : "popout";
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

let popoutHost: HTMLSpanElement | null = null;
let popoutRoot: Root | null = null;
let modalHost: HTMLSpanElement | null = null;
let modalRoot: Root | null = null;
let openObserver: MutationObserver | null = null;
let profileObserver: MutationObserver | null = null;
let watchedRoot: HTMLElement | null = null;

const PROFILE_OPEN_RE = /userProfileModal|userProfileOuter|userPopoutOuter|profilePanel|biteSize/;

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

function watchProfileRoot(root: HTMLElement | null) {
    if (root === watchedRoot && profileObserver) return;
    profileObserver?.disconnect();
    profileObserver = null;
    watchedRoot = root;
    if (!root) return;
    profileObserver = new MutationObserver(records => {
        for (const rec of records) {
            if (rec.target instanceof Element && rec.target.closest(".vc-profile-button-host")) continue;
            schedulePlace();
            return;
        }
    });
    profileObserver.observe(root, { childList: true, subtree: true });
}

function hostValid(host: HTMLElement | null) {
    return Boolean(host?.isConnected && host.previousElementSibling && host.parentElement);
}

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

function placeInRoot(root: HTMLElement) {
    const nameEl = findNameInRoot(root);
    if (!nameEl) return false;

    const userId = findUserIdNear(nameEl);
    if (!userId) return false;

    const row = nameEl.parentElement;
    if (!row) return false;

    const kind = profileKind(root);
    const hostId = kind === "modal" ? "vc-profile-button-modal-host" : "vc-profile-button-popout-host";
    let host = kind === "modal" ? modalHost : popoutHost;
    let reactRoot = kind === "modal" ? modalRoot : popoutRoot;

    if (host?.isConnected && row.contains(host) && host.previousElementSibling === nameEl && host.getAttribute("data-user-id") === userId)
        return true;

    profileObserver?.disconnect();
    removeHost(kind);

    host = document.createElement("span");
    host.id = hostId;
    host.className = cl("host", kind === "modal" && "host-modal");
    host.setAttribute("data-user-id", userId);

    if (nameEl.nextSibling)
        row.insertBefore(host, nameEl.nextSibling);
    else
        row.appendChild(host);

    if (getComputedStyle(row).display === "block")
        row.classList.add(cl("name-row"));

    reactRoot = createRoot(host);
    reactRoot.render(<ProfileLinkButton userId={userId} />);

    if (kind === "modal") {
        modalHost = host;
        modalRoot = reactRoot;
    } else {
        popoutHost = host;
        popoutRoot = reactRoot;
    }
    if (watchedRoot) watchProfileRoot(watchedRoot);
    return true;
}

function placeButton() {
    let needPopout = false;
    let needModal = false;
    let watch: HTMLElement | null = null;
    for (const root of profileRoots()) {
        const kind = profileKind(root);
        if (kind === "modal") needModal = true;
        else needPopout = true;
        if (!watch) watch = root;
    }

    if (!needPopout && popoutHost && !popoutHost.isConnected) removeHost("popout");
    if (!needModal && modalHost && !modalHost.isConnected) removeHost("modal");

    const popoutOk = !needPopout || hostValid(popoutHost);
    const modalOk = !needModal || hostValid(modalHost);
    if (popoutOk && modalOk) {
        watchProfileRoot(watch);
        return;
    }

    if (needPopout && !hostValid(popoutHost)) {
        for (const root of profileRoots()) {
            if (profileKind(root) !== "popout") continue;
            if (placeInRoot(root)) {
                watch = root;
                break;
            }
        }
    }
    if (needModal && !hostValid(modalHost)) {
        for (const root of profileRoots()) {
            if (profileKind(root) !== "modal") continue;
            if (placeInRoot(root)) {
                watch = root;
                break;
            }
        }
    }

    if (!needPopout && popoutHost && !popoutHost.isConnected) removeHost("popout");
    if (!needModal && modalHost && !modalHost.isConnected) removeHost("modal");
    watchProfileRoot(watch);
}

const schedulePlace = debounce(() => {
    try { placeButton(); } catch { /* ignore */ }
}, 120);

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

    start() {
        void loadRegistry();
        scheduleShare();
        schedulePlace();
        openObserver = new MutationObserver(records => {
            if (didOpenOrCloseProfile(records)) schedulePlace();
        });
        openObserver.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        openObserver?.disconnect();
        openObserver = null;
        profileObserver?.disconnect();
        profileObserver = null;
        watchedRoot = null;
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
