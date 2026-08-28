/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BadgePosition, BadgeUserArgs, ProfileBadge } from "@api/Badges";
import { Heart } from "@components/Heart";
import { LinkIcon } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import definePlugin from "@utils/types";
import { Tooltip, UserProfileStore, UserStore, useEffect, useStateFromStores } from "@webpack/common";

import { Delexo } from "../_delexo/author";
import {
    getOwnBadgeShare,
    getOwnButtonShare,
    noteOpenProfile,
    refreshUserProfile,
    startLiveShare,
    stopLiveShare
} from "../_delexo/liveShare";
import { profileBadgesFromShare } from "../badges/render";
import { decodeShare as decodeBadgeShare } from "../badges/share";
import {
    decodeShare as decodeButtonShare,
    isHttpUrl,
    type ButtonShare
} from "../profileButton/share";
import managedStyle from "./style.css?managed";

const cl = classNameFactory("vc-profile-button-");
const REGISTRY_URL = "https://raw.githubusercontent.com/Delexoo/Vencord/main/src/userplugins/profileButton/registry.json";

let registry: Record<string, ButtonShare> = {};

function ownId() {
    return UserStore.getCurrentUser()?.id;
}

function registryShare(userId: string): ButtonShare | null {
    const item = registry[userId];
    if (!item) return null;
    const label = String(item.label ?? "").trim().slice(0, 32);
    const url = String(item.url ?? "").trim();
    if (!label || !isHttpUrl(url)) return null;
    return { label, url, heart: item.heart !== false };
}

function badgeShareFor(userId: string) {
    if (userId === ownId()) {
        return getOwnBadgeShare() ?? decodeBadgeShare(UserProfileStore.getUserProfile(userId)?.bio);
    }
    return decodeBadgeShare(UserProfileStore.getUserProfile(userId)?.bio);
}

function buttonShareFor(userId: string): ButtonShare | null {
    if (userId === ownId()) {
        return getOwnButtonShare() ?? decodeButtonShare(UserProfileStore.getUserProfile(userId)?.bio) ?? registryShare(userId);
    }
    return decodeButtonShare(UserProfileStore.getUserProfile(userId)?.bio) ?? registryShare(userId);
}

function openButtonUrl(url: string) {
    if (!isHttpUrl(url)) return;
    try {
        VencordNative.native.openExternal(url);
    } catch {
        window.open(url, "_blank", "noopener,noreferrer");
    }
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
        try { (UserProfileStore as { emitChange?: () => void; }).emitChange?.(); } catch { /* ignore */ }
    } catch {
        // ignore
    }
}

function ProfileButtonBadge(props: ProfileBadge & BadgeUserArgs) {
    const profile = useStateFromStores(
        [UserProfileStore],
        () => UserProfileStore.getUserProfile(props.userId)
    );

    useEffect(() => {
        noteOpenProfile(props.userId);
        void refreshUserProfile(props.userId, true).catch(() => undefined);
    }, [props.userId]);

    const data = props.userId === ownId()
        ? getOwnButtonShare() ?? decodeButtonShare(profile?.bio) ?? registryShare(props.userId)
        : decodeButtonShare(profile?.bio) ?? registryShare(props.userId);

    if (!data) return null;

    return (
        <Tooltip
            text={
                <span className={cl("tip")}>
                    <span className={cl("tip-name")}>{data.label}</span>
                    {data.heart ? <Heart className={cl("tip-heart")} /> : null}
                </span>
            }
            hideOnClick
        >
            {tip => (
                <span
                    {...tip}
                    className={cl("badge")}
                    role="button"
                    tabIndex={0}
                    aria-label={data.label}
                    onClick={event => {
                        tip.onClick?.();
                        event.preventDefault();
                        event.stopPropagation();
                        openButtonUrl(data.url);
                    }}
                    onKeyDown={event => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        openButtonUrl(data.url);
                    }}
                >
                    {data.heart
                        ? <Heart className={cl("icon")} />
                        : <LinkIcon width={14} height={14} className={cl("icon")} />}
                </span>
            )}
        </Tooltip>
    );
}

function getBadges({ userId }: BadgeUserArgs): ProfileBadge[] {
    const badges = profileBadgesFromShare(badgeShareFor(userId), userId);
    const button = buttonShareFor(userId);
    if (!button) return badges;
    return [{
        id: "delexo_profile_button",
        key: "delexo_profile_button",
        component: ProfileButtonBadge,
        position: BadgePosition.START,
        link: button.url,
        onClick(event) {
            event.preventDefault();
            event.stopPropagation();
            const next = buttonShareFor(userId);
            if (next) openButtonUrl(next.url);
        }
    }, ...badges];
}

const profileBadge: ProfileBadge = {
    id: "delexo_share",
    getBadges,
    position: BadgePosition.START
};

export default definePlugin({
    name: "DelexoShare",
    description: "Shows Delexo profile badges and profile buttons for every Vencord user.",
    authors: [Delexo],
    required: true,
    hidden: true,
    requiresRestart: false,
    dependencies: ["BadgeAPI"],
    managedStyle,
    userProfileBadge: profileBadge,

    start() {
        startLiveShare();
        void loadRegistry();
    },

    flux: {
        USER_PROFILE_MODAL_OPEN({ userId }: { userId?: string; }) {
            if (userId) {
                noteOpenProfile(userId);
                void refreshUserProfile(String(userId), true).catch(() => undefined);
            }
        }
    },

    stop() {
        stopLiveShare();
    }
});
