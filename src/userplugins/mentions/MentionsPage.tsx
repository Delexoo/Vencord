/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@utils/css";
import { OptionType } from "@utils/types";
import {
    Avatar,
    ChannelRouter,
    ChannelStore,
    Clickable,
    GuildStore,
    IconUtils,
    MessageActions,
    Modal,
    openModal,
    Parser,
    RestAPI,
    Select,
    Text,
    UserStore,
    useEffect,
    useState,
} from "@webpack/common";
import type { RenderModalProps } from "@vencord/discord-types";

const cl = classNameFactory("vc-mentions-");

export type MentionFilter = "user" | "all";
export type MentionRange = "day" | "week" | "year" | "all";

const RANGE_OPTIONS: { label: string; value: MentionRange; }[] = [
    { label: "Past day", value: "day" },
    { label: "Past week", value: "week" },
    { label: "Past year", value: "year" },
    { label: "All time", value: "all" },
];

export const settings = definePluginSettings({
    defaultFilter: {
        type: OptionType.SELECT,
        description: "Default mention type when opening Mentions",
        default: "user" as MentionFilter,
        options: [
            { label: "Direct @you only", value: "user", default: true },
            { label: "All (@everyone, roles, you)", value: "all" },
        ]
    },
    defaultRange: {
        type: OptionType.SELECT,
        description: "Default time range when opening Mentions",
        default: "week" as MentionRange,
        options: [
            { label: "Past day", value: "day" },
            { label: "Past week", value: "week", default: true },
            { label: "Past year", value: "year" },
            { label: "All time", value: "all" },
        ]
    }
});

export type MentionMessage = {
    id: string;
    channel_id: string;
    guild_id?: string | null;
    content?: string;
    timestamp?: string;
    edited_timestamp?: string | null;
    author?: {
        id: string;
        username?: string;
        global_name?: string | null;
        avatar?: string | null;
    };
    mentions?: { id: string; username?: string; }[];
    mention_roles?: string[];
    mention_everyone?: boolean;
};

function formatWhen(iso?: string) {
    if (!iso) return "";
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

function guildLabel(guildId?: string | null) {
    if (!guildId) return "Direct Message";
    try {
        return GuildStore.getGuild(guildId)?.name || `Server ${guildId}`;
    } catch {
        return `Server ${guildId}`;
    }
}

function channelLabel(channelId: string, guildId?: string | null) {
    try {
        const ch = ChannelStore.getChannel(channelId);
        if (!ch) return `#${channelId}`;
        if (ch.isDM?.()) return "DM";
        if (ch.isGroupDM?.() || ch.isMultiUserDM?.()) return ch.name || "Group DM";
        return `#${ch.name || channelId}`;
    } catch {
        return guildId ? `#${channelId}` : channelId;
    }
}

function authorName(m: MentionMessage) {
    return m.author?.global_name || m.author?.username || "Unknown";
}

function jumpTo(m: MentionMessage) {
    try {
        ChannelRouter.transitionToChannel(m.channel_id);
        setTimeout(() => {
            try {
                MessageActions.jumpToMessage({
                    channelId: m.channel_id,
                    messageId: m.id,
                    flash: true,
                    jumpType: "ANIMATED"
                });
            } catch { /* ignore */ }
        }, 400);
    } catch { /* ignore */ }
}

async function fetchMentions(limit = 100): Promise<MentionMessage[]> {
    try {
        const res = await RestAPI.get({
            url: "/users/@me/mentions",
            query: {
                limit,
                roles: true,
                everyone: true
            }
        });
        const body = res?.body;
        if (Array.isArray(body)) return body as MentionMessage[];
        if (Array.isArray(body?.messages)) return body.messages as MentionMessage[];
        return [];
    } catch (e) {
        console.error("[Mentions] fetch failed", e);
        return [];
    }
}

function currentUserId() {
    try {
        return UserStore.getCurrentUser()?.id ?? "";
    } catch {
        return "";
    }
}

function isDirectUserMention(m: MentionMessage, userId: string) {
    if (!userId) return false;
    return m.mentions?.some(u => u.id === userId) ?? false;
}

function rangeCutoffMs(range: MentionRange): number | null {
    const now = Date.now();
    switch (range) {
        case "day": return now - 24 * 60 * 60 * 1000;
        case "week": return now - 7 * 24 * 60 * 60 * 1000;
        case "year": return now - 365 * 24 * 60 * 60 * 1000;
        case "all": return null;
        default: {
            const _exhaustive: never = range;
            return _exhaustive;
        }
    }
}

function messageTimeMs(m: MentionMessage): number {
    if (!m.timestamp) return 0;
    const t = Date.parse(m.timestamp);
    return Number.isFinite(t) ? t : 0;
}

function filterMentions(
    items: MentionMessage[],
    filter: MentionFilter,
    range: MentionRange,
    userId: string
) {
    const cutoff = rangeCutoffMs(range);
    return items.filter(m => {
        if (filter === "user" && !isDirectUserMention(m, userId)) return false;
        if (cutoff != null && messageTimeMs(m) < cutoff) return false;
        return true;
    });
}

function rangeLabel(range: MentionRange) {
    switch (range) {
        case "day": return "past day";
        case "week": return "past week";
        case "year": return "past year";
        case "all": return "all time";
        default: {
            const _exhaustive: never = range;
            return _exhaustive;
        }
    }
}

function normalizeRange(v: unknown): MentionRange {
    if (v === "day" || v === "week" || v === "year" || v === "all") return v;
    return "week";
}

function mentionKindLabel(m: MentionMessage, userId: string) {
    if (m.mention_everyone) return "@everyone";
    if (m.mention_roles?.length) return "@role";
    if (isDirectUserMention(m, userId)) return `@${UserStore.getCurrentUser()?.username ?? "you"}`;
    return null;
}

function MentionRow({ m, onJump, userId }: { m: MentionMessage; onJump: () => void; userId: string; }) {
    const guildId = m.guild_id ?? ChannelStore.getChannel(m.channel_id)?.guild_id ?? null;
    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const guildIcon = guild
        ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 40 })
        : null;
    const kind = mentionKindLabel(m, userId);

    return (
        <button type="button" className={cl("row")} onClick={onJump}>
            <div className={cl("row-icons")}>
                {guildIcon
                    ? <img className={cl("guild-icon")} src={guildIcon} alt="" />
                    : <div className={cl("guild-fallback")}>{(guildLabel(guildId)[0] || "?").toUpperCase()}</div>}
                {m.author?.id
                    ? <Avatar
                        className={cl("author-avatar")}
                        size="SIZE_24"
                        src={IconUtils.getUserAvatarURL(UserStore.getUser(m.author.id) ?? m.author as any, false, 48)}
                    />
                    : null}
            </div>
            <div className={cl("row-body")}>
                <div className={cl("row-top")}>
                    <Text variant="text-sm/semibold" className={cl("server")}>{guildLabel(guildId)}</Text>
                    <Text variant="text-xs/normal" className={cl("meta")}>{channelLabel(m.channel_id, guildId)}</Text>
                    <Text variant="text-xs/normal" className={cl("when")}>{formatWhen(m.timestamp)}</Text>
                </div>
                <div className={cl("row-mid")}>
                    <Text variant="text-sm/medium">{authorName(m)}</Text>
                    {kind
                        ? (
                            <span className={cl("pill", kind.startsWith("@everyone") ? "pill-everyone" : kind === "@role" ? "pill-role" : "pill-user")}>
                                {kind}
                            </span>
                        )
                        : null}
                </div>
                <div className={cl("row-content")}>
                    {Parser.parse(m.content || "*(no text)*", true, {
                        channelId: m.channel_id,
                        messageId: m.id,
                        allowLinks: true,
                        allowHeading: false,
                        allowList: false,
                    })}
                </div>
            </div>
            <Text variant="text-xs/semibold" className={cl("jump")}>Jump</Text>
        </button>
    );
}

function MentionsPage({ modalProps }: { modalProps: RenderModalProps; }) {
    const [items, setItems] = useState<MentionMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [filter, setFilter] = useState<MentionFilter>(() => {
        const v = settings.store.defaultFilter;
        return v === "all" ? "all" : "user";
    });
    const [range, setRange] = useState<MentionRange>(() => normalizeRange(settings.store.defaultRange));

    const userId = currentUserId();
    const username = UserStore.getCurrentUser()?.username ?? "you";
    const byType = filter === "user"
        ? items.filter(m => isDirectUserMention(m, userId))
        : items;
    const visible = filterMentions(items, filter, range, userId);
    const hiddenByTime = byType.length - filterMentions(byType, "all", range, userId).length;

    async function reload() {
        setLoading(true);
        setError("");
        const list = await fetchMentions(100);
        setItems(list);
        setLoading(false);
        if (!list.length) setError("");
    }

    function setFilterAndSave(next: MentionFilter) {
        setFilter(next);
        settings.store.defaultFilter = next;
    }

    function setRangeAndSave(next: MentionRange) {
        setRange(next);
        settings.store.defaultRange = next;
    }

    useEffect(() => {
        void reload();
    }, []);

    const filterLabel = filter === "user" ? `@${username}` : "All";

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Mentions"
            subtitle={
                filter === "user"
                    ? `Direct @${username} mentions · ${rangeLabel(range)}`
                    : `All mentions including @everyone and @roles · ${rangeLabel(range)}`
            }
            actions={[
                {
                    text: "Refresh",
                    variant: "secondary",
                    onClick: () => void reload()
                },
                {
                    text: "Close",
                    variant: "primary",
                    onClick: modalProps.onClose
                }
            ]}
        >
            <div className={cl("page")}>
                <div className={cl("filters")}>
                    <div className={cl("filter-tabs")} role="tablist" aria-label="Mention type">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={filter === "user"}
                            className={cl("filter-btn", filter === "user" && "filter-btn-active")}
                            onClick={() => setFilterAndSave("user")}
                        >
                            @{username}
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={filter === "all"}
                            className={cl("filter-btn", filter === "all" && "filter-btn-active")}
                            onClick={() => setFilterAndSave("all")}
                        >
                            All
                        </button>
                    </div>

                    <div className={cl("range")}>
                        <Text variant="text-xs/semibold" className={cl("range-label")}>From</Text>
                        <Select
                            options={RANGE_OPTIONS.map(o => ({
                                ...o,
                                default: o.value === "week"
                            }))}
                            serialize={String}
                            isSelected={v => v === range}
                            select={v => setRangeAndSave(normalizeRange(v))}
                            closeOnSelect
                        />
                    </div>
                </div>

                {loading ? (
                    <Text variant="text-sm/normal" className={cl("empty")}>Loading mentions…</Text>
                ) : visible.length === 0 ? (
                    <div className={cl("empty")}>
                        <Text variant="text-md/semibold">
                            {filter === "user"
                                ? `No @${username} mentions in the ${rangeLabel(range)}`
                                : `No mentions in the ${rangeLabel(range)}`}
                        </Text>
                        <Text variant="text-sm/normal">
                            {range !== "all"
                                ? "Try a longer time range, or switch type filters above."
                                : filter === "user"
                                    ? `Switch to All to include @everyone and @role pings.`
                                    : "When someone @you, @everyone, or @roles you have, it will show up here."}
                        </Text>
                        {error ? <Text variant="text-sm/normal" className={cl("err")}>{error}</Text> : null}
                    </div>
                ) : (
                    <>
                        <Text variant="text-xs/medium" className={cl("count")}>
                            {visible.length} {filterLabel} mention{visible.length === 1 ? "" : "s"} · {rangeLabel(range)}
                            {filter === "user" && items.length !== byType.length
                                ? ` · ${items.length - byType.length} hidden (@everyone / @role)`
                                : ""}
                            {hiddenByTime > 0
                                ? ` · ${hiddenByTime} outside time range`
                                : ""}
                        </Text>
                        <div className={cl("list")}>
                            {visible.map(m => (
                                <MentionRow
                                    key={`${m.channel_id}-${m.id}`}
                                    m={m}
                                    userId={userId}
                                    onJump={() => {
                                        modalProps.onClose();
                                        jumpTo(m);
                                    }}
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}

export function openMentionsPage() {
    openModal(props => (
        <ErrorBoundary>
            <MentionsPage modalProps={props} />
        </ErrorBoundary>
    ));
}

export const MentionsNavItem = ErrorBoundary.wrap(function MentionsNavItem() {
    return (
        <div key="vc-mentions" className={cl("nav")} role="listitem">
            <Clickable className={cl("nav-btn")} onClick={() => openMentionsPage()}>
                <span className={cl("nav-icon")} aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1.1 14.9-.4.1a.6.6 0 0 1-.74-.74l.1-.4A4.5 4.5 0 1 1 16.5 12a1.1 1.1 0 0 1-2.2 0 2.3 2.3 0 1 0-1.2 4.9Z" />
                    </svg>
                </span>
                <span className={cl("nav-label")}>Mentions</span>
            </Clickable>
        </div>
    );
}, { noop: true });

export function renderMentionsNav() {
    return <MentionsNavItem />;
}
