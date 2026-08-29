/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { updateMessage } from "@api/MessageUpdater";
import { Settings } from "@api/Settings";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Button, ChannelStore, FluxDispatcher, GuildStore, MessageActions, MessageCache, MessageStore, SelectedChannelStore } from "@webpack/common";

import Plugins from "~plugins";

import { Delexo } from "../_delexo/author";
import managedStyle from "./style.css?managed";

const Native = VencordNative.pluginHelpers.MessageLoggerKeep as PluginNative<typeof import("./native")> | undefined;

type KeepFor = "forever" | "year" | "month" | "week" | "day";

type SavedMessage = {
    messageId: string;
    channelId: string;
    guildId: string;
    authorId: string;
    authorName: string;
    authorUsername: string;
    sentAt: string;
    deletedAt: string;
    guildName: string;
    channelName: string;
    content: string;
    attachments: string[];
    kind: "deleted" | "edited";
    raw: Record<string, unknown>;
};

const KEEP_OPTIONS = [
    { label: "Forever", value: "forever", default: true },
    { label: "1 Year", value: "year" },
    { label: "1 Month", value: "month" },
    { label: "1 Week", value: "week" },
    { label: "1 Day", value: "day" }
] as const;

const live = new Map<string, SavedMessage>();
let purgeTimer: ReturnType<typeof setInterval> | null = null;
let injected = false;
let nativeWarned = false;

function native() {
    if (Native) return Native;
    if (!nativeWarned) {
        nativeWarned = true;
        console.warn("[MessageLoggerKeep] Native file logging needs a full Discord restart.");
    }
    return undefined;
}

function keepFor(): KeepFor {
    const v = Settings.plugins.MessageLogger?.keepFor;
    switch (v) {
        case "forever":
        case "year":
        case "month":
        case "week":
        case "day":
            return v;
        default:
            return "forever";
    }
}

function retentionMs(value: KeepFor): number | null {
    switch (value) {
        case "forever":
            return null;
        case "year":
            return 365 * 24 * 60 * 60 * 1000;
        case "month":
            return 30 * 24 * 60 * 60 * 1000;
        case "week":
            return 7 * 24 * 60 * 60 * 1000;
        case "day":
            return 24 * 60 * 60 * 1000;
        default: {
            const _exhaustive: never = value;
            return _exhaustive;
        }
    }
}

function iso(value: unknown) {
    if (value == null || value === "") return "";
    if (value instanceof Date)
        return Number.isFinite(value.getTime()) ? value.toISOString() : "";
    if (typeof value === "number") {
        const d = new Date(value);
        return Number.isFinite(d.getTime()) ? d.toISOString() : "";
    }
    if (typeof value === "string") {
        const d = new Date(value);
        return Number.isFinite(d.getTime()) ? d.toISOString() : "";
    }
    const obj = value as { toISOString?: () => string; valueOf?: () => unknown; };
    if (typeof obj.toISOString === "function") {
        try {
            const s = obj.toISOString();
            if (typeof s === "string" && Number.isFinite(Date.parse(s)))
                return new Date(s).toISOString();
        } catch { /* ignore */ }
    }
    if (typeof obj.valueOf === "function") {
        const n = Number(obj.valueOf());
        if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
    }
    return "";
}

function snowflakeIso(id: string) {
    try {
        const ms = Number((BigInt(id) >> 22n) + 1420070400000n);
        return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
    } catch {
        return "";
    }
}

function sentIso(saved: SavedMessage) {
    return snowflakeIso(saved.messageId) || iso(saved.sentAt) || iso(saved.raw?.timestamp);
}

function compareIds(a: string, b: string) {
    try {
        const delta = BigInt(a) - BigInt(b);
        return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    } catch {
        if (a.length !== b.length) return a.length - b.length;
        return a < b ? -1 : a > b ? 1 : 0;
    }
}

function orderMessages(arr: { id?: string; }[] | undefined) {
    if (!Array.isArray(arr) || arr.length < 2) return;
    arr.sort((a, b) => compareIds(String(a?.id ?? "0"), String(b?.id ?? "0")));
}

function orderCache(cache: any) {
    if (!cache) return cache;
    try {
        orderMessages(cache._array);
        orderMessages(cache._messages);
        orderMessages(cache._before?._messages);
        orderMessages(cache._after?._messages);
    } catch { /* cache arrays can be frozen on some Discord builds */ }
    return cache;
}

function commitOrdered(cache: any) {
    MessageCache.commit(orderCache(cache));
    MessageStore.emitChange();
}

function inLoadedWindow(cache: any, id: string) {
    const arr = Array.isArray(cache?._array)
        ? cache._array.filter((m: { id?: string; }) => String(m.id) !== id)
        : [];
    if (!arr.length)
        return Boolean(cache?.ready || cache?.hasFetched || cache?.has?.(id));
    let oldest = String(arr[0].id ?? "");
    let newest = oldest;
    for (const m of arr) {
        const mid = String(m.id ?? "");
        if (compareIds(mid, oldest) < 0) oldest = mid;
        if (compareIds(mid, newest) > 0) newest = mid;
    }
    if (compareIds(id, oldest) >= 0 && compareIds(id, newest) <= 0) return true;
    if (compareIds(id, oldest) < 0) return cache.hasMoreBefore === false;
    return cache.hasMoreAfter === false;
}

function pretty(value: string) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return value || "unknown";
    return d.toLocaleString();
}

function pick(obj: any, key: string) {
    if (!obj) return "";
    try {
        const v = obj[key];
        return v == null ? "" : String(v);
    } catch {
        return "";
    }
}

function authorUsername(msg: any) {
    return pick(msg?.author, "username") || "unknown";
}

function authorBlob(msg: any) {
    const u = msg?.author;
    if (!u) return { id: "", username: "unknown", globalName: "", discriminator: "0", avatar: null, bot: false };
    const blob = typeof u.toJS === "function" ? u.toJS() : u;
    return {
        id: String(blob.id ?? ""),
        username: String(blob.username ?? "unknown"),
        globalName: blob.globalName ?? null,
        discriminator: String(blob.discriminator ?? "0"),
        avatar: blob.avatar ?? null,
        bot: Boolean(blob.bot),
        publicFlags: blob.publicFlags
    };
}

function channelMeta(channelId: string) {
    const ch = ChannelStore.getChannel(channelId);
    const guild = ch?.guild_id ? GuildStore.getGuild(ch.guild_id) : null;
    const channelName = ch?.name ? `#${ch.name}` : ch?.isDM?.() || !ch?.guild_id ? "DM" : channelId;
    return {
        guildId: ch?.guild_id ? String(ch.guild_id) : "",
        guildName: guild?.name || "",
        channelName: String(channelName),
        where: guild ? `${guild.name} / ${channelName}` : String(channelName)
    };
}

function attachmentLines(msg: any): string[] {
    return (msg?.attachments ?? []).map((a: any) => {
        const name = a?.filename || a?.id || "file";
        const url = a?.url || a?.proxy_url || "";
        return url ? `${name} (${url})` : String(name);
    });
}

function rawMessage(msg: any, deleted: boolean): Record<string, unknown> {
    const author = authorBlob(msg);
    return {
        id: String(msg.id),
        channel_id: String(msg.channel_id),
        guild_id: msg.guild_id ?? ChannelStore.getChannel(msg.channel_id)?.guild_id ?? null,
        type: msg.type ?? 0,
        flags: msg.flags ?? 0,
        content: msg.content ?? "",
        timestamp: snowflakeIso(String(msg.id)) || iso(msg.timestamp) || new Date().toISOString(),
        edited_timestamp: msg.edited_timestamp ? iso(msg.edited_timestamp) : null,
        tts: Boolean(msg.tts),
        mention_everyone: Boolean(msg.mention_everyone),
        mentions: msg.mentions ?? [],
        mention_roles: msg.mention_roles ?? [],
        attachments: msg.attachments ?? [],
        embeds: msg.embeds ?? [],
        pinned: Boolean(msg.pinned),
        author,
        message_reference: msg.message_reference ?? null,
        referenced_message: msg.referenced_message ?? null,
        nonce: msg.nonce,
        deleted,
        editHistory: msg.editHistory ?? []
    };
}

function snapshot(msg: any, kind: "deleted" | "edited"): SavedMessage | null {
    if (!msg?.id || !msg.channel_id) return null;
    if ((msg.flags & 64) === 64) return null;
    const meta = channelMeta(msg.channel_id);
    const author = authorBlob(msg);
    return {
        messageId: String(msg.id),
        channelId: String(msg.channel_id),
        guildId: meta.guildId,
        authorId: author.id,
        authorName: author.globalName || author.username,
        authorUsername: author.username,
        sentAt: snowflakeIso(String(msg.id)) || iso(msg.timestamp) || new Date().toISOString(),
        deletedAt: new Date().toISOString(),
        guildName: meta.guildName,
        channelName: meta.channelName,
        content: String(msg.content ?? ""),
        attachments: attachmentLines(msg),
        kind,
        raw: rawMessage(msg, kind === "deleted")
    };
}

function rememberLive(msg: any) {
    const snap = snapshot(msg, "deleted");
    if (!snap) return;
    live.set(snap.messageId, snap);
    if (live.size <= 2500) return;
    const first = live.keys().next().value;
    if (first) live.delete(first);
}

function markdownEntry(saved: SavedMessage) {
    const lines = [
        `## ${saved.kind === "deleted" ? "Deleted" : "Edited"} — ${pretty(saved.deletedAt)}`,
        "",
        `- **When sent:** ${pretty(saved.sentAt)}`,
        `- **When ${saved.kind}:** ${pretty(saved.deletedAt)}`,
        `- **Who:** ${saved.authorName} (@${saved.authorUsername}) \`${saved.authorId}\``,
        `- **Where:** ${saved.guildName ? `${saved.guildName} / ${saved.channelName}` : saved.channelName}`,
        `- **Channel ID:** ${saved.channelId}`,
        `- **Message ID:** ${saved.messageId}`,
    ];
    if (saved.attachments.length) {
        lines.push("- **Attachments:**");
        for (const a of saved.attachments) lines.push(`  - ${a}`);
    }
    lines.push("", saved.content || "*(no text)*", "", "---");
    return lines.join("\n");
}

async function persist(saved: SavedMessage) {
    const api = native();
    if (!api) return;
    try {
        const res = await api.saveCached(saved.channelId, saved.messageId, JSON.stringify(saved));
        const meta = res?.ok && res.data ? JSON.parse(String(res.data)) as { existed?: boolean; } : {};
        if (!meta.existed) {
            await api.appendUserLog(saved.authorName, saved.authorUsername, saved.authorId, markdownEntry(saved));
        }
    } catch (e) {
        console.error("[MessageLoggerKeep] failed to save", e);
    }
}

function messageFromEvent(event: any): any {
    return event?.message ?? event;
}

function saveDeleted(channelId: string, id: string) {
    const msg = MessageStore.getMessage(channelId, id) as any;
    const saved = (msg && snapshot(msg, "deleted")) || live.get(id);
    if (!saved) return;
    saved.kind = "deleted";
    saved.deletedAt = new Date().toISOString();
    saved.raw = { ...saved.raw, deleted: true };
    live.set(id, saved);
    void persist(saved);
}

function saveEdited(channelId: string, id: string) {
    const msg = MessageStore.getMessage(channelId, id) as any;
    if (!msg) return;
    const saved = snapshot(msg, "edited");
    if (!saved) return;
    live.set(id, saved);
    void persist(saved);
}

function deletedPayload(saved: SavedMessage) {
    const timestamp = sentIso(saved);
    return {
        ...saved.raw,
        id: saved.messageId,
        channel_id: saved.channelId,
        timestamp: timestamp || saved.raw.timestamp,
        deleted: true,
        state: "SENT"
    };
}

function markDeleted(cache: any, messageId: string) {
    if (!cache?.has?.(messageId) || typeof cache.update !== "function") return cache;
    return cache.update(messageId, (old: any) =>
        old.set ? old.set("deleted", true) : old.merge({ deleted: true })
    );
}

function injectSaved(saved: SavedMessage) {
    if (saved.kind !== "deleted") return;
    const channelId = saved.channelId;
    const messageId = saved.messageId;
    try {
        let cache = MessageCache.getOrCreate(channelId);
        if (cache.has(messageId)) {
            commitOrdered(markDeleted(cache, messageId));
            return;
        }
        if (!inLoadedWindow(cache, messageId)) return;
        if (typeof cache.receiveMessage !== "function") throw new Error("receiveMessage missing");
        cache = cache.receiveMessage(deletedPayload(saved));
        commitOrdered(markDeleted(cache, messageId));
    } catch (e) {
        try {
            MessageActions.receiveMessage(channelId, deletedPayload(saved));
            updateMessage(channelId, messageId, { deleted: true });
            commitOrdered(MessageCache.getOrCreate(channelId));
        } catch (inner) {
            console.error("[MessageLoggerKeep] failed to restore", messageId, e, inner);
        }
    }
}

const restoring = new Set<string>();

async function restoreChannelReady(channelId: string) {
    if (restoring.has(channelId)) return;
    const api = native();
    if (!api) return;
    restoring.add(channelId);
    try {
        const res = await api.loadChannelCache(channelId);
        if (!res?.ok || !res.data) return;
        const items = JSON.parse(String(res.data)) as SavedMessage[];
        items.sort((a, b) => compareIds(a.messageId, b.messageId));
        for (const saved of items) {
            if (saved.kind !== "deleted") continue;
            injectSaved(saved);
        }
        commitOrdered(MessageCache.getOrCreate(channelId));
    } catch (e) {
        console.error("[MessageLoggerKeep] failed to load channel cache", e);
    } finally {
        restoring.delete(channelId);
    }
}

function restoreChannel(channelId: string | null | undefined) {
    if (!channelId) return;
    try {
        if (typeof MessageStore.whenReady === "function") {
            MessageStore.whenReady(channelId, () => {
                void restoreChannelReady(channelId);
            });
            return;
        }
    } catch { /* ignore */ }
    void restoreChannelReady(channelId);
}

function expireUi(saved: SavedMessage) {
    if (saved.kind === "deleted") {
        FluxDispatcher.dispatch({
            type: "MESSAGE_DELETE",
            channelId: saved.channelId,
            id: saved.messageId,
            mlDeleted: true
        });
        return;
    }
    updateMessage(saved.channelId, saved.messageId, { editHistory: [] });
}

async function purge() {
    const ms = retentionMs(keepFor());
    if (ms == null) return;
    const cutoff = Date.now() - ms;
    const api = native();
    if (api) {
        try { await api.purgeOlderThan(cutoff); } catch { /* ignore */ }
    }
    for (const [id, saved] of [...live]) {
        if (Date.parse(saved.deletedAt) >= cutoff) continue;
        expireUi(saved);
        live.delete(id);
    }
}

function Disclaimer() {
    return (
        <Paragraph className="vc-ml-keep-disclaimer">
            Deleted and edited messages are saved on this PC as <code>{"{name}.md"}</code> in Documents → MessageLogger (who, when, where, and the text). They are restored after Discord restarts.
        </Paragraph>
    );
}

function OpenLogsFolder() {
    return (
        <Button
            size={Button.Sizes.SMALL}
            onClick={() => { void native()?.openLogsFolder(); }}
        >
            Open logs folder
        </Button>
    );
}

function injectMessageLoggerSettings() {
    if (injected) return;
    const ml = Plugins.MessageLogger as any;
    const def = ml?.settings?.def;
    if (!ml || !def) return;

    if (!ml.authors?.some((a: { id?: bigint; }) => a.id === Delexo.id))
        ml.authors = [Delexo, ...(ml.authors ?? [])];

    const keepForSetting = {
        type: OptionType.SELECT,
        description: "How long deleted messages stay in Discord. Local .md files are kept either way.",
        default: "forever",
        options: [...KEEP_OPTIONS],
        onChange() { void purge(); }
    };
    const openLogsFolder = {
        type: OptionType.COMPONENT,
        component: OpenLogsFolder
    };
    const disclaimer = {
        type: OptionType.COMPONENT,
        component: Disclaimer
    };

    const next: Record<string, unknown> = { disclaimer };
    for (const [key, value] of Object.entries(def)) {
        if (key === "disclaimer" || key === "keepFor" || key === "openLogsFolder") continue;
        next[key] = value;
    }
    next.keepFor = keepForSetting;
    next.openLogsFolder = openLogsFolder;
    ml.settings.def = next;

    const store = Settings.plugins.MessageLogger;
    if (store && store.keepFor == null) store.keepFor = "forever";
    injected = true;
}

export default definePlugin({
    name: "MessageLoggerKeep",
    description: "Saves deleted messages locally under the sender's name and restores them after Discord restarts.",
    authors: [Delexo],
    tags: ["Chat", "Utility"],
    hidden: true,
    enabledByDefault: true,
    requiresRestart: true,
    managedStyle,
    searchTerms: ["message logger", "deleted", "edited", "retention", "markdown"],

    flux: {
        MESSAGE_CREATE(event: any) {
            const msg = messageFromEvent(event);
            if (msg?.id) rememberLive(msg);
        },
        MESSAGE_UPDATE({ message }: { message?: Message; }) {
            if (message?.id) rememberLive(message);
            if (!message?.id || !message.edited_timestamp) return;
            queueMicrotask(() => saveEdited(message.channel_id, message.id));
        },
        MESSAGE_DELETE({ channelId, id, mlDeleted }: { channelId: string; id: string; mlDeleted?: boolean; }) {
            if (mlDeleted || !id) return;
            saveDeleted(channelId, id);
        },
        MESSAGE_DELETE_BULK({ channelId, ids }: { channelId: string; ids?: string[]; }) {
            for (const id of ids ?? []) saveDeleted(channelId, id);
        },
        LOAD_MESSAGES_SUCCESS({ channelId }: { channelId?: string; }) {
            if (channelId) void restoreChannel(channelId);
        },
        CHANNEL_SELECT({ channelId }: { channelId?: string; }) {
            if (channelId) void restoreChannel(channelId);
        }
    },

    start() {
        injectMessageLoggerSettings();
        void purge();
        void restoreChannel(SelectedChannelStore.getChannelId());
        if (purgeTimer != null) clearInterval(purgeTimer);
        purgeTimer = setInterval(() => { void purge(); }, 60_000);
    },

    stop() {
        if (purgeTimer != null) clearInterval(purgeTimer);
        purgeTimer = null;
    }
});
