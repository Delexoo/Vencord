/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { ActivityType } from "@vencord/discord-types/enums";
import { Button, IconUtils, PresenceStore, Select, showToast, Text, UserProfileStore, UserStore, useEffect, useStateFromStores } from "@webpack/common";
import type { CSSProperties } from "react";

import { Delexo } from "../_delexo/author";
import { createShareSync, patchOwnBio, refreshUserProfile, setOwnBadgeShare, startLiveShare, stopLiveShare } from "../_delexo/liveShare";
import { publishBadgeShare, startShareRegistry, stopShareRegistry } from "../_delexo/shareRegistry";
import {
    badgeIcon,
    CHOICE_GROUPS,
    CONTRIBUTOR_BADGE,
    findChoiceOption,
    HELP_ARTICLE,
    SECTION_LABELS,
    SECTIONS,
    TOGGLE_BADGES,
    VENCORD_CONTRIBUTOR_ICON,
    type BadgeOption,
    type BadgeSection,
    type ChoiceGroup,
} from "./catalog";
import {
    decodeShare,
    packState,
    shareHasAnything,
    stripShare,
    writeShare,
    type ShareState,
} from "./share";
import managedStyle from "./style.css?managed";

const cl = classNameFactory("vc-delexo-badges-");

type ChoiceKey = typeof CHOICE_GROUPS[number]["key"];
type ToggleId = typeof TOGGLE_BADGES[number]["id"];

function groupByKey(key: ChoiceKey) {
    const group = CHOICE_GROUPS.find(item => item.key === key);
    if (!group) throw new Error(`Unknown badge group: ${key}`);
    return group;
}

function choiceOptions(group: ChoiceGroup) {
    return [
        { label: "Off", value: "off", default: true },
        ...group.options.map(option => ({ label: option.name, value: option.id }))
    ];
}

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
    nitro: {
        type: OptionType.SELECT,
        description: "Discord Nitro",
        hidden: true,
        options: choiceOptions(groupByKey("nitro"))
    },
    booster: {
        type: OptionType.SELECT,
        description: "Server Booster",
        hidden: true,
        options: choiceOptions(groupByKey("booster"))
    },
    bugHunter: {
        type: OptionType.SELECT,
        description: "Bug Hunter",
        hidden: true,
        options: choiceOptions(groupByKey("bugHunter"))
    },
    hypeHouse: {
        type: OptionType.SELECT,
        description: "HypeSquad House",
        hidden: true,
        options: choiceOptions(groupByKey("hypeHouse"))
    },
    gifting: {
        type: OptionType.SELECT,
        description: "Gifting Badge",
        hidden: true,
        options: choiceOptions(groupByKey("gifting"))
    },
    accountAge: {
        type: OptionType.SELECT,
        description: "Account Age",
        hidden: true,
        options: choiceOptions(groupByKey("accountAge"))
    },
    streaming: {
        type: OptionType.SELECT,
        description: "Streaming",
        hidden: true,
        options: choiceOptions(groupByKey("streaming"))
    },
    gameTime: {
        type: OptionType.SELECT,
        description: "Game Time",
        hidden: true,
        options: choiceOptions(groupByKey("gameTime"))
    },
    gameVariety: {
        type: OptionType.SELECT,
        description: "Game Variety",
        hidden: true,
        options: choiceOptions(groupByKey("gameVariety"))
    },
    quest: {
        type: OptionType.BOOLEAN,
        description: "Discord Quests",
        default: false,
        hidden: true
    },
    orbs: {
        type: OptionType.BOOLEAN,
        description: "Orbs",
        default: false,
        hidden: true
    },
    legacyUsername: {
        type: OptionType.BOOLEAN,
        description: "Legacy Username",
        default: false,
        hidden: true
    },
    staff: {
        type: OptionType.BOOLEAN,
        description: "Discord Staff",
        default: false,
        hidden: true
    },
    hypeEvents: {
        type: OptionType.BOOLEAN,
        description: "HypeSquad Events",
        default: false,
        hidden: true
    },
    moderatorAlumni: {
        type: OptionType.BOOLEAN,
        description: "Moderator Program Alumni",
        default: false,
        hidden: true
    },
    earlySupporter: {
        type: OptionType.BOOLEAN,
        description: "Early Supporter",
        default: false,
        hidden: true
    },
    partner: {
        type: OptionType.BOOLEAN,
        description: "Partnered Server Owner",
        default: false,
        hidden: true
    },
    lastMeadow: {
        type: OptionType.BOOLEAN,
        description: "Last Meadow Online",
        default: false,
        hidden: true
    },
    verifiedDeveloper: {
        type: OptionType.BOOLEAN,
        description: "Early Verified Bot Developer",
        default: false,
        hidden: true
    },
    activeDeveloper: {
        type: OptionType.BOOLEAN,
        description: "Active Developer",
        default: false,
        hidden: true
    },
    verified: {
        type: OptionType.BOOLEAN,
        description: "Verified",
        default: false,
        hidden: true
    }
});

const STORE_KEYS = [
    "vencordContributor",
    ...CHOICE_GROUPS.map(group => group.key),
    ...TOGGLE_BADGES.map(badge => badge.id),
] as const;

function ownId() {
    return UserStore.getCurrentUser()?.id;
}

function contributorOn() {
    return settings.store.vencordContributor !== false;
}

function choiceValue(key: ChoiceKey) {
    return String((settings.store as Record<string, unknown>)[key] ?? "off");
}

function toggleOn(id: ToggleId) {
    return (settings.store as Record<string, unknown>)[id] === true;
}

function currentShareState(): ShareState {
    const choices: Record<string, string> = {};
    for (const group of CHOICE_GROUPS) choices[group.key] = choiceValue(group.key);
    const toggles: Record<string, boolean> = {};
    for (const badge of TOGGLE_BADGES) toggles[badge.id] = toggleOn(badge.id);
    return {
        contributor: contributorOn(),
        choices,
        toggles,
    };
}

async function syncShareToBio() {
    const state = currentShareState();
    setOwnBadgeShare(state);
    const userId = ownId();
    if (userId) {
        void publishBadgeShare(userId, shareHasAnything(state) ? packState(state) : "");
    }
    try {
        await patchOwnBio(bio => writeShare(bio, state));
        if (!userId || !shareHasAnything(state)) return;
        const saved = UserProfileStore.getUserProfile(userId)?.bio;
        if (!decodeShare(saved)) {
            await patchOwnBio(bio => writeShare(bio, state, "zw"));
        }
    } catch (e) {
        try {
            await patchOwnBio(bio => writeShare(bio, currentShareState(), "zw"));
        } catch (inner) {
            console.error("[Badges] failed to save client-side badge share", inner ?? e);
        }
    }
}

const scheduleShare = createShareSync(syncShareToBio);

function applyGodMode() {
    const store = settings.store as Record<string, unknown>;
    store.vencordContributor = true;
    for (const group of CHOICE_GROUPS) {
        const top = group.options[group.options.length - 1];
        if (top) store[group.key] = top.id;
    }
    for (const badge of TOGGLE_BADGES) store[badge.id] = true;
    setOwnBadgeShare(currentShareState());
    scheduleShare();
    showToast("All badges set to max");
}

function applyReset() {
    const store = settings.store as Record<string, unknown>;
    store.vencordContributor = false;
    for (const group of CHOICE_GROUPS) store[group.key] = "off";
    for (const badge of TOGGLE_BADGES) store[badge.id] = false;
    setOwnBadgeShare(currentShareState());
    scheduleShare();
    showToast("Badges reset");
}

function enabledOptions(): BadgeOption[] {
    const out: BadgeOption[] = [];
    for (const group of CHOICE_GROUPS) {
        const selected = findChoiceOption(group, choiceValue(group.key));
        if (selected) out.push(selected);
    }
    for (const badge of TOGGLE_BADGES) {
        if (toggleOn(badge.id)) out.push(badge);
    }
    return out;
}

function badgeSrc(badge: { icon?: string; iconSrc?: string; }) {
    if (badge.iconSrc) return badge.iconSrc;
    if (!badge.icon) return "";
    if (/^https?:\/\//.test(badge.icon)) return badge.icon;
    return badgeIcon(badge.icon);
}

type PreviewBadge = { key: string; src: string; title: string; };

function clanBadgeUrl(clan: { badge?: string; identityGuildId?: string; } | null | undefined) {
    if (!clan?.badge || !clan.identityGuildId) return "";
    return `https://cdn.discordapp.com/clan-badges/${clan.identityGuildId}/${clan.badge}.png?size=32`;
}

function bannerStyle(userId: string | undefined, profile: { banner?: string | null; accentColor?: number | null; } | undefined): CSSProperties {
    if (userId && profile?.banner) {
        const url = IconUtils.getUserBannerURL({
            id: userId,
            banner: profile.banner,
            canAnimate: true,
            size: 480
        });
        if (url) {
            return {
                backgroundImage: `url(${url})`,
                backgroundSize: "cover",
                backgroundPosition: "center"
            };
        }
    }
    if (typeof profile?.accentColor === "number" && profile.accentColor > 0) {
        return { backgroundColor: `#${profile.accentColor.toString(16).padStart(6, "0")}` };
    }
    return { backgroundColor: "var(--background-tertiary, #1e1f22)" };
}

function ProfilePreview({ badges }: { badges: PreviewBadge[]; }) {
    const me = useStateFromStores([UserStore], () => UserStore.getCurrentUser());
    const profile = useStateFromStores(
        [UserProfileStore],
        () => me ? UserProfileStore.getUserProfile(me.id) : undefined
    );
    const presence = useStateFromStores([PresenceStore], () => {
        if (!me) return { status: "offline" as const, text: "", emojiUrl: "", emojiName: "" };
        const status = PresenceStore.getStatus(me.id) ?? "offline";
        const custom = PresenceStore.getActivities(me.id)?.find(a => a.type === ActivityType.CUSTOM_STATUS);
        const emoji = custom?.emoji;
        return {
            status,
            text: custom?.state ?? "",
            emojiUrl: emoji?.id
                ? `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}?size=32`
                : "",
            emojiName: emoji?.name ?? ""
        };
    });

    if (!me) return null;

    const displayName = me.globalName || me.username;
    const bio = stripShare(profile?.bio ?? "").trim();
    const pronouns = (profile?.pronouns ?? "").trim();
    const clan = me.primaryGuild;
    const showClan = Boolean(clan?.identityEnabled !== false && clan?.tag);
    const nameplate = me.collectibles?.nameplate;
    const statusClass = presence.status === "idle" || presence.status === "dnd"
        || presence.status === "online" || presence.status === "streaming"
        || presence.status === "invisible" || presence.status === "offline"
        ? presence.status
        : "offline";
    const hasCustom = Boolean(presence.text || presence.emojiUrl || presence.emojiName);

    return (
        <div className={cl("card")}>
            <div className={cl("banner")} style={bannerStyle(me.id, profile)} />
            <div className={cl("body")}>
                <div className={cl("avatar-row")}>
                    <div className={cl("avatar-wrap")}>
                        <img
                            className={cl("avatar")}
                            src={me.getAvatarURL(void 0, 128, true)}
                            alt=""
                        />
                        <span
                            className={cl("status", `status-${statusClass}`)}
                            title={statusClass}
                        />
                    </div>
                    {hasCustom && (
                        <div className={cl("custom")}>
                            {presence.emojiUrl
                                ? <img src={presence.emojiUrl} alt="" />
                                : presence.emojiName
                                    ? <span className={cl("custom-emoji")}>{presence.emojiName}</span>
                                    : <span className={cl("custom-plus")}>+</span>}
                            {presence.text
                                ? <span className={cl("custom-text")}>{presence.text}</span>
                                : null}
                        </div>
                    )}
                </div>

                <div className={cl("name")}>{displayName}</div>
                <div className={cl("meta")}>
                    <span className={cl("handle")}>@{me.username}</span>
                    {pronouns ? <span className={cl("dot")}>•</span> : null}
                    {pronouns ? <span className={cl("pronouns")}>{pronouns}</span> : null}
                    {showClan && clan ? (
                        <>
                            <span className={cl("dot")}>•</span>
                            <span className={cl("tag")} title={clan.tag}>
                                {clanBadgeUrl(clan)
                                    ? <img src={clanBadgeUrl(clan)} alt="" />
                                    : null}
                                {clan.tag}
                            </span>
                        </>
                    ) : null}
                    {nameplate?.label ? (
                        <span className={cl("tag", "tag-plate")}>{nameplate.label}</span>
                    ) : null}
                </div>

                <div className={cl("live")} aria-label="Profile badges">
                    {badges.map(badge => (
                        <img key={badge.key} src={badge.src} alt={badge.title} title={badge.title} />
                    ))}
                    {badges.length === 0 && <span className={cl("empty")}>No badges on yet.</span>}
                </div>

                {bio ? (
                    <div className={cl("about")}>
                        <div className={cl("about-label")}>About Me</div>
                        <div className={cl("bio")}>{bio}</div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function ChoiceRow({ group }: { group: ChoiceGroup; }) {
    const selected = choiceValue(group.key);
    const current = findChoiceOption(group, selected);
    return (
        <div className={cl("row")}>
            <img
                className={cl("icon")}
                src={badgeIcon((current ?? group.options[0]).hash)}
                alt=""
            />
            <div className={cl("choice")}>
                <Heading tag="h5">{group.label}</Heading>
                <Select
                    placeholder="Off"
                    options={choiceOptions(group)}
                    maxVisibleItems={11}
                    closeOnSelect
                    select={value => {
                        (settings.store as Record<string, unknown>)[group.key] = value;
                        scheduleShare();
                    }}
                    isSelected={value => value === selected}
                    serialize={String}
                />
                {group.section !== "experiment" && (
                    <span className={cl("note")}>{group.description}</span>
                )}
            </div>
        </div>
    );
}

function ToggleRow({ badge }: { badge: typeof TOGGLE_BADGES[number]; }) {
    return (
        <div className={cl("row")}>
            <img className={cl("icon")} src={badgeIcon(badge.hash)} alt="" />
            <FormSwitch
                title={badge.name}
                description={badge.description}
                value={toggleOn(badge.id)}
                hideBorder
                onChange={on => {
                    (settings.store as Record<string, unknown>)[badge.id] = on;
                    scheduleShare();
                }}
            />
        </div>
    );
}

function Section({ id }: { id: BadgeSection; }) {
    const groups = CHOICE_GROUPS.filter(group => group.section === id);
    const toggles = [
        ...(id === CONTRIBUTOR_BADGE.section ? [CONTRIBUTOR_BADGE] : []),
        ...TOGGLE_BADGES.filter(badge => badge.section === id)
    ];
    if (!groups.length && !toggles.length) return null;
    return (
        <div className={cl("section")}>
            <Heading tag="h3" className={cl("section-title")}>{SECTION_LABELS[id]}</Heading>
            {groups.map(group => <ChoiceRow key={group.key} group={group} />)}
            {toggles.map(badge => <ToggleRow key={badge.id} badge={badge} />)}
        </div>
    );
}

function SettingsPanel() {
    settings.use([...STORE_KEYS] as never);
    const me = useStateFromStores([UserStore], () => UserStore.getCurrentUser());
    const profile = useStateFromStores(
        [UserProfileStore],
        () => me ? UserProfileStore.getUserProfile(me.id) : undefined
    );

    useEffect(() => {
        if (!me?.id) return;
        void refreshUserProfile(me.id, true).catch(() => undefined);
    }, [me?.id]);

    const extra = enabledOptions();
    const mine = (profile?.badges ?? []).filter(badge => badge && (badge.icon || (badge as { iconSrc?: string; }).iconSrc));
    const seen = new Set(mine.map(badge => badge.id));
    const extras = extra.filter(badge => !seen.has(badge.discordId));
    const preview: PreviewBadge[] = [];
    if (contributorOn()) {
        preview.push({ key: "contributor", src: VENCORD_CONTRIBUTOR_ICON, title: "Vencord Contributor" });
    }
    for (const badge of mine) {
        const src = badgeSrc(badge);
        if (!src) continue;
        preview.push({ key: badge.id || src, src, title: badge.description || badge.id });
    }
    for (const badge of extras) {
        preview.push({ key: badge.id, src: badgeIcon(badge.hash), title: badge.name });
    }

    return (
        <div className={cl("panel")}>
            <Text variant="heading-lg/semibold" className={cl("title")}>Profile</Text>
            <ProfilePreview badges={preview} />
            <div className={cl("actions")}>
                <Button
                    className={cl("godmode")}
                    color={Button.Colors.BRAND}
                    onClick={applyGodMode}
                >
                    LARPMODE
                </Button>
                <Button
                    className={cl("reset")}
                    color={Button.Colors.PRIMARY}
                    onClick={applyReset}
                >
                    Reset
                </Button>
            </div>
            <div className={cl("hint")}>
                Client-side badges from <Link href={HELP_ARTICLE}>Profile Badges 101</Link>. Anyone with Vencord installed can see them. Changes show up in about a second while a profile is open.
            </div>

            {SECTIONS.map(id => <Section key={id} id={id} />)}
        </div>
    );
}

export default definePlugin({
    name: "Badges",
    description: "Toggle official Discord profile badges onto your profile. Anyone with Vencord installed can see them.",
    authors: [Delexo],
    tags: ["Appearance"],
    enabledByDefault: true,
    requiresRestart: false,
    settings,
    managedStyle,

    start() {
        startLiveShare();
        startShareRegistry();
        setOwnBadgeShare(currentShareState());
        scheduleShare();
    },

    flux: {
        CONNECTION_OPEN() {
            setOwnBadgeShare(currentShareState());
            scheduleShare();
        }
    },

    stop() {
        setOwnBadgeShare(null);
        stopShareRegistry();
        stopLiveShare();
    }
});
