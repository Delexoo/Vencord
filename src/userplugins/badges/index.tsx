/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BadgePosition, BadgeUserArgs, ProfileBadge } from "@api/Badges";
import { definePluginSettings } from "@api/Settings";
import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { UserStore } from "@webpack/common";

import { Delexo, DELEXO_DISCORD_ID } from "../_delexo/author";
import { ICONS } from "./icons";
import managedStyle from "./style.css?managed";

const cl = classNameFactory("vc-delexo-badges-");

/** Official Vencord contributor badge art (cdn.discordapp.com/emojis/1092089799109775453). */
const VENCORD_CONTRIBUTOR_ICON = "https://cdn.discordapp.com/emojis/1092089799109775453.png?size=64";
const VENCORD_CONTRIBUTOR_USER_ID = String(DELEXO_DISCORD_ID);

export const BADGE_DEFS = [
    {
        id: "nightCircuit",
        name: "Night Circuit",
        description: "Wired into the after-hours grid.",
        icon: ICONS.nightCircuit
    },
    {
        id: "emberSigil",
        name: "Ember Sigil",
        description: "A mark that never quite goes cold.",
        icon: ICONS.emberSigil
    },
    {
        id: "lunarDrift",
        name: "Lunar Drift",
        description: "Caught between dusk and the next tide.",
        icon: ICONS.lunarDrift
    },
    {
        id: "aetherBloom",
        name: "Aether Bloom",
        description: "Grown in light that isn't from this room.",
        icon: ICONS.aetherBloom
    },
    {
        id: "ironVeil",
        name: "Iron Veil",
        description: "Quiet armor, still standing.",
        icon: ICONS.ironVeil
    },
    {
        id: "stormcall",
        name: "Stormcall",
        description: "First to hear the sky split open.",
        icon: ICONS.stormcall
    },
    {
        id: "voidglass",
        name: "Voidglass",
        description: "Looks through what others bounce off.",
        icon: ICONS.voidglass
    },
    {
        id: "riftwalker",
        name: "Riftwalker",
        description: "Leaves a seam wherever it steps.",
        icon: ICONS.riftwalker
    },
] as const;

type BadgeId = typeof BADGE_DEFS[number]["id"];

const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: SettingsPanel
    },
    vencordContributor: {
        type: OptionType.BOOLEAN,
        description: "Vencord Contributor",
        default: true,
        hidden: true
    },
    nightCircuit: {
        type: OptionType.BOOLEAN,
        description: "Night Circuit",
        default: false,
        hidden: true
    },
    emberSigil: {
        type: OptionType.BOOLEAN,
        description: "Ember Sigil",
        default: false,
        hidden: true
    },
    lunarDrift: {
        type: OptionType.BOOLEAN,
        description: "Lunar Drift",
        default: false,
        hidden: true
    },
    aetherBloom: {
        type: OptionType.BOOLEAN,
        description: "Aether Bloom",
        default: false,
        hidden: true
    },
    ironVeil: {
        type: OptionType.BOOLEAN,
        description: "Iron Veil",
        default: false,
        hidden: true
    },
    stormcall: {
        type: OptionType.BOOLEAN,
        description: "Stormcall",
        default: false,
        hidden: true
    },
    voidglass: {
        type: OptionType.BOOLEAN,
        description: "Voidglass",
        default: false,
        hidden: true
    },
    riftwalker: {
        type: OptionType.BOOLEAN,
        description: "Riftwalker",
        default: false,
        hidden: true
    }
});

function isOn(id: BadgeId) {
    return settings.store[id] === true;
}

function ownId() {
    return UserStore.getCurrentUser()?.id;
}

function contributorOn() {
    return settings.store.vencordContributor !== false;
}

function SettingsPanel() {
    settings.use([
        "vencordContributor",
        "nightCircuit",
        "emberSigil",
        "lunarDrift",
        "aetherBloom",
        "ironVeil",
        "stormcall",
        "voidglass",
        "riftwalker"
    ]);
    const enabled = BADGE_DEFS.filter(badge => isOn(badge.id));
    const preview = [
        ...(contributorOn() ? [{ id: "vencordContributor", name: "Vencord Contributor", icon: VENCORD_CONTRIBUTOR_ICON }] : []),
        ...enabled
    ];

    return (
        <div className={cl("panel")}>
            <div className={cl("hint")}>
                The Vencord Contributor badge is pinned to Discord ID {VENCORD_CONTRIBUTOR_USER_ID}. Custom badges below are for your own profile. Reopen a profile to refresh.
            </div>
            <div className={cl("live")} aria-label="Enabled badges">
                {preview.length === 0
                    ? <span className={cl("empty")}>No badges on yet.</span>
                    : preview.map(badge => (
                        <img key={badge.id} src={badge.icon} alt={badge.name} title={badge.name} />
                    ))}
            </div>
            <div className={cl("row")}>
                <img className={cl("icon")} src={VENCORD_CONTRIBUTOR_ICON} alt="" />
                <FormSwitch
                    title="Vencord Contributor"
                    description="Official Vencord contributor badge on Delexo's profile."
                    value={contributorOn()}
                    hideBorder
                    onChange={on => {
                        settings.store.vencordContributor = on;
                    }}
                />
            </div>
            <div className={cl("split")} />
            {BADGE_DEFS.map(badge => (
                <div key={badge.id} className={cl("row")}>
                    <img className={cl("icon")} src={badge.icon} alt="" />
                    <FormSwitch
                        title={badge.name}
                        description={badge.description}
                        value={isOn(badge.id)}
                        hideBorder
                        onChange={on => {
                            settings.store[badge.id] = on;
                        }}
                    />
                </div>
            ))}
        </div>
    );
}

function getBadges({ userId }: BadgeUserArgs): ProfileBadge[] {
    const badges: ProfileBadge[] = [];

    if (userId === VENCORD_CONTRIBUTOR_USER_ID && contributorOn()) {
        badges.push({
            id: "delexo_vencord_contributor",
            key: "delexo_vencord_contributor",
            description: "Vencord Contributor",
            iconSrc: VENCORD_CONTRIBUTOR_ICON,
            position: BadgePosition.START
        });
    }

    if (userId !== ownId()) return badges;

    badges.push(...BADGE_DEFS.filter(badge => isOn(badge.id)).map(badge => ({
        id: `delexo_badge_${badge.id}`,
        key: `delexo_badge_${badge.id}`,
        description: badge.name,
        iconSrc: badge.icon,
        position: BadgePosition.START,
        props: {
            style: {
                borderRadius: "50%",
                width: "22px",
                height: "22px"
            }
        }
    })));

    return badges;
}

const profileBadge: ProfileBadge = {
    id: "delexo_badges",
    getBadges,
    position: BadgePosition.START
};

export default definePlugin({
    name: "Badges",
    description: "Toggle unique badges onto your Discord profile.",
    authors: [Delexo],
    dependencies: ["BadgeAPI"],
    tags: ["Appearance"],
    settings,
    managedStyle,
    userProfileBadge: profileBadge
});
