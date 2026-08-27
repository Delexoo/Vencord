/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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

function findActionAnchor(): HTMLElement | null {
    const nodes = document.querySelectorAll<HTMLElement>("button, [role='button']");
    for (const el of nodes) {
        if (el.closest("#vc-profile-button-popout-host, #vc-profile-button-modal-host")) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/^(message|edit profile|view full profile)$/i.test(t)) return el;
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
        ? currentShare()
        : decodeShare(profile?.bio);

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
    description: "Add a custom button (name + link) on profiles. Other people with this plugin can see yours.",
    authors: [Delexo],
    tags: ["Appearance"],
    searchTerms: ["donate", "button", "profile", "link", "kofi", "stripe", "paypal", "heart"],
    requiresRestart: false,
    settings,
    managedStyle,

    start() {
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
