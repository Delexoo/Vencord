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
import { SelectedGuildStore, Tooltip, UserProfileStore, UserStore, useEffect, useStateFromStores } from "@webpack/common";

import { Delexo } from "../_delexo/author";
import {
    getOwnBadgeShare,
    getOwnButtonShare,
    noteOpenProfile,
    startLiveShare,
    stopLiveShare
} from "../_delexo/liveShare";
import {
    refreshShareRegistry,
    registryBadgeShare,
    registryButtonShare,
    startShareRegistry,
    stopShareRegistry
} from "../_delexo/shareRegistry";
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

type ProfileArgs = BadgeUserArgs & {
    user_id?: string;
    user?: { id?: string; };
    bio?: string;
    _userProfile?: { userId?: string; user_id?: string; bio?: string; };
};

let registry: Record<string, ButtonShare> = {};

function ownId() {
    return UserStore.getCurrentUser()?.id;
}

function resolveUserId(args: ProfileArgs | null | undefined) {
    if (!args) return "";
    try {
        const id = args.userId || args.user_id || args.user?.id
            || args._userProfile?.userId || args._userProfile?.user_id;
        return id ? String(id) : "";
    } catch {
        return "";
    }
}

function biosFrom(args?: ProfileArgs | null) {
    const out: string[] = [];
    const push = (value: unknown) => {
        if (typeof value === "string" && value) out.push(value);
    };
    push(args?.bio);
    push(args?._userProfile?.bio);
    try {
        push((args as { getPreviewBio?: (bio?: string) => string; })?.getPreviewBio?.());
    } catch { /* ignore */ }
    return out;
}

function profileOf(userId: string) {
    if (!userId) return undefined;
    try {
        return UserProfileStore.getUserProfile(userId);
    } catch {
        return undefined;
    }
}

function shareBio(userId: string, args?: ProfileArgs | null) {
    const stored = profileOf(userId)?.bio;
    let guildBio: string | undefined;
    try {
        const guildId = SelectedGuildStore.getGuildId?.();
        if (guildId) guildBio = UserProfileStore.getGuildMemberProfile?.(userId, guildId)?.bio;
    } catch { /* ignore */ }
    for (const bio of [...biosFrom(args), stored, guildBio]) {
        if (bio && (decodeBadgeShare(bio) || decodeButtonShare(bio))) return bio;
    }
    return stored ?? biosFrom(args)[0] ?? guildBio;
}

function registryShare(userId: string): ButtonShare | null {
    const item = registry[userId];
    if (!item) return null;
    const label = String(item.label ?? "").trim().slice(0, 32);
    const url = String(item.url ?? "").trim();
    if (!label || !isHttpUrl(url)) return null;
    return { label, url, heart: item.heart !== false };
}

function badgeShareFor(userId: string, args?: ProfileArgs | null) {
    const bio = shareBio(userId, args);
    if (userId && userId === ownId()) {
        return getOwnBadgeShare() ?? decodeBadgeShare(bio) ?? registryBadgeShare(userId);
    }
    return decodeBadgeShare(bio) ?? registryBadgeShare(userId);
}

function buttonShareFor(userId: string, args?: ProfileArgs | null): ButtonShare | null {
    const bio = shareBio(userId, args);
    if (userId && userId === ownId()) {
        return getOwnButtonShare() ?? decodeButtonShare(bio) ?? registryButtonShare(userId) ?? registryShare(userId);
    }
    return decodeButtonShare(bio) ?? registryButtonShare(userId) ?? registryShare(userId);
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
    const userId = resolveUserId(props);
    const profile = useStateFromStores(
        [UserProfileStore],
        () => profileOf(userId)
    );

    useEffect(() => {
        if (userId) noteOpenProfile(userId);
    }, [userId]);

    const data = buttonShareFor(userId, {
        ...props,
        userId,
        bio: profile?.bio ?? (props as ProfileArgs).bio
    });

    if (!data) return <span className={cl("slot-empty")} aria-hidden />;

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

function getBadges(args: BadgeUserArgs): ProfileBadge[] {
    const userId = resolveUserId(args);
    if (userId) noteOpenProfile(userId);
    const bio = shareBio(userId, args as ProfileArgs);
    const button = buttonShareFor(userId, args as ProfileArgs);
    const shared = profileBadgesFromShare(
        badgeShareFor(userId, { ...args, userId, bio } as ProfileArgs),
        userId
    );

    return [{
        id: "delexo_profile_button",
        key: "delexo_profile_button",
        userId,
        bio,
        component: ProfileButtonBadge,
        position: BadgePosition.START,
        link: button?.url,
        onClick(event) {
            event.preventDefault();
            event.stopPropagation();
            const next = buttonShareFor(userId, args as ProfileArgs);
            if (next) openButtonUrl(next.url);
        }
    }, ...shared.map(badge => ({
        id: badge.id,
        key: badge.key ?? badge.id,
        description: badge.description,
        iconSrc: badge.iconSrc,
        link: badge.link,
        position: BadgePosition.START
    }))];
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
    requiresRestart: true,
    dependencies: ["BadgeAPI"],
    managedStyle,
    userProfileBadge: profileBadge,

    start() {
        startLiveShare();
        startShareRegistry();
        void loadRegistry();
        void refreshShareRegistry();
    },

    flux: {
        USER_PROFILE_MODAL_OPEN({ userId }: { userId?: string; }) {
            if (userId) noteOpenProfile(userId);
        },
        USER_PROFILE_FETCH_SUCCESS({ userProfile }: { userProfile?: { user?: { id?: string; }; user_id?: string; userId?: string; }; }) {
            const id = String(userProfile?.user?.id ?? userProfile?.user_id ?? userProfile?.userId ?? "");
            if (id) noteOpenProfile(id);
        }
    },

    stop() {
        stopShareRegistry();
        stopLiveShare();
    }
});
