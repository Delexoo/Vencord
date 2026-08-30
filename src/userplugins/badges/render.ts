/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BadgePosition, type ProfileBadge } from "@api/Badges";
import { UserStore } from "@webpack/common";

import { badgeIcon, VENCORD_CONTRIBUTOR_ICON, type BadgeOption } from "./catalog";
import { stateToOptions, type ShareState } from "./share";

function legacyUsernameTooltip(userId?: string) {
    const user = (userId && UserStore.getUser(userId)) || UserStore.getCurrentUser();
    const name = user?.username;
    const disc = user?.discriminator && user.discriminator !== "0" ? `#${user.discriminator}` : "";
    return name ? `Originally known as ${name}${disc}` : "Legacy Username";
}

export function toProfileBadge(option: BadgeOption, userId?: string): ProfileBadge {
    const description = option.discordId === "legacy_username"
        ? legacyUsernameTooltip(userId)
        : option.description;
    return {
        id: `delexo_${option.discordId}`,
        key: option.discordId,
        description,
        iconSrc: badgeIcon(option.hash),
        link: option.link,
        position: BadgePosition.START
    };
}

export function profileBadgesFromShare(state: ShareState | null, userId: string): ProfileBadge[] {
    if (!state) return [];
    const badges: ProfileBadge[] = [];
    if (state.contributor) {
        badges.push({
            id: "delexo_vencord_contributor",
            key: "delexo_vencord_contributor",
            description: "Vencord Contributor",
            iconSrc: VENCORD_CONTRIBUTOR_ICON,
            position: BadgePosition.START
        });
    }
    badges.push(...stateToOptions(state).map(option => toProfileBadge(option, userId)));
    return badges;
}
