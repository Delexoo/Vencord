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
import { Button, ChannelStore, FluxDispatcher, GuildStore, MessageStore } from "@webpack/common";

import Plugins from "~plugins";

import { Delexo } from "../_delexo/author";
import managedStyle from "./style.css?managed";

const Native = VencordNative.pluginHelpers.MessageLoggerKeep as PluginNative<typeof import("./native")> | undefined;

type KeepFor = "forever" | "year" | "month" | "week" | "day";

type Tracked = {
    channelId: string;
    messageId: string;
    deleted: boolean;
    loggedAt: number;
};

const KEEP_OPTIONS = [
    { label: "Forever", value: "forever", default: true },
    { label: "1 Year", value: "year" },
    { label: "1 Month", value: "month" },
    { label: "1 Week", value: "week" },
    { label: "1 Day", value: "day" }
] as const;

const tracked = new Map<string, Tracked>();
let purgeTimer: ReturnType<typeof setInterval> | null = null;
let injected = false;

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

function yaml(fields: Record<string, string>) {
    return Object.entries(fields)
        .map(([k, v]) => `${k}: ${JSON.stringify(v ?? "")}`)
        .join("\n");
}

function authorName(msg: Message) {
    const u = msg.author as { globalName?: string; username?: string; } | undefined;
    return u?.globalName || u?.username || "unknown";
}

function channelLabel(channelId: string) {
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return channelId;
    const guild = ch.guild_id ? GuildStore.getGuild(ch.guild_id) : null;
    const name = ch.name ? `#${ch.name}` : "DM";
    return guild ? `${guild.name} / ${name}` : name;
}

function toMarkdown(kind: "deleted" | "edited", msg: Message, extra: string) {
    const loggedAt = new Date().toISOString();
    const header = yaml({
        type: kind,
        messageId: String(msg.id),
        channelId: String(msg.channel_id),
        author: authorName(msg),
        authorId: String(msg.author?.id ?? ""),
        channel: channelLabel(msg.channel_id),
        loggedAt
    });
    return `---\n${header}\n---\n\n${extra.trim()}\n`;
}

function editBody(msg: any) {
    const history: Array<{ content?: string; timestamp?: Date | string; }> = msg.editHistory ?? [];
    const parts: string[] = [];
    history.forEach((edit, i) => {
        parts.push(`## Edit ${i + 1}`);
        if (edit.timestamp) parts.push(`_${String(edit.timestamp)}_`);
        parts.push(edit.content || "");
        parts.push("");
    });
    parts.push("## Current");
    parts.push(msg.content || "");
    return parts.join("\n");
}

async function writeMd(id: string, content: string) {
    if (!Native) return;
    try {
        await Native.writeLog(id, content);
    } catch { /* ignore */ }
}

function remember(msg: Message, deleted: boolean) {
    const loggedAt = Date.now();
    tracked.set(msg.id, {
        channelId: msg.channel_id,
        messageId: msg.id,
        deleted,
        loggedAt
    });
}

function saveDeleted(channelId: string, id: string) {
    const msg = MessageStore.getMessage(channelId, id) as any;
    if (!msg) return;
    remember(msg, true);
    const body = [
        `**${authorName(msg)}** in ${channelLabel(channelId)}`,
        "",
        msg.content || "*(no text)*"
    ].join("\n");
    void writeMd(id, toMarkdown("deleted", msg, body));
}

function saveEdited(channelId: string, id: string) {
    const msg = MessageStore.getMessage(channelId, id) as any;
    if (!msg?.editHistory?.length) return;
    remember(msg, false);
    void writeMd(id, toMarkdown("edited", msg, editBody(msg)));
}

function expireUi(entry: Tracked) {
    if (entry.deleted) {
        FluxDispatcher.dispatch({
            type: "MESSAGE_DELETE",
            channelId: entry.channelId,
            id: entry.messageId,
            mlDeleted: true
        });
        return;
    }
    updateMessage(entry.channelId, entry.messageId, { editHistory: [] });
}

async function purge() {
    const ms = retentionMs(keepFor());
    if (ms == null) return;
    const cutoff = Date.now() - ms;

    for (const [id, entry] of [...tracked]) {
        if (entry.loggedAt >= cutoff) continue;
        expireUi(entry);
        tracked.delete(id);
    }

    if (Native) {
        try { await Native.purgeOlderThan(cutoff); } catch { /* ignore */ }
    }
}

function Disclaimer() {
    return (
        <Paragraph className="vc-ml-keep-disclaimer">
            Delexo did not make MessageLogger. This is the original Vencord plugin; Delexo only added how long logs stay and saving deleted/edited messages as local .md files.
        </Paragraph>
    );
}

function OpenLogsFolder() {
    return (
        <Button
            size={Button.Sizes.SMALL}
            onClick={() => { void Native?.openLogsFolder(); }}
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

    const keepFor = {
        type: OptionType.SELECT,
        description: "How long deleted and edited messages stay. Also saved as .md files on this device.",
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
    next.keepFor = keepFor;
    next.openLogsFolder = openLogsFolder;
    ml.settings.def = next;

    const store = Settings.plugins.MessageLogger;
    if (store && store.keepFor == null) store.keepFor = "forever";
    injected = true;
}

export default definePlugin({
    name: "MessageLoggerKeep",
    description: "Keeps MessageLogger history for a chosen duration and saves deleted/edited messages as local .md files.",
    authors: [Delexo],
    tags: ["Chat", "Utility"],
    hidden: true,
    enabledByDefault: true,
    managedStyle,
    searchTerms: ["message logger", "deleted", "edited", "retention", "markdown"],

    flux: {
        MESSAGE_DELETE({ channelId, id, mlDeleted }: { channelId: string; id: string; mlDeleted?: boolean; }) {
            if (mlDeleted || !id) return;
            queueMicrotask(() => saveDeleted(channelId, id));
        },
        MESSAGE_DELETE_BULK({ channelId, ids }: { channelId: string; ids?: string[]; }) {
            for (const id of ids ?? [])
                queueMicrotask(() => saveDeleted(channelId, id));
        },
        MESSAGE_UPDATE({ message }: { message?: Message; }) {
            if (!message?.id || !message.edited_timestamp) return;
            queueMicrotask(() => saveEdited(message.channel_id, message.id));
        }
    },

    start() {
        injectMessageLoggerSettings();
        void purge();
        if (purgeTimer != null) clearInterval(purgeTimer);
        purgeTimer = setInterval(() => { void purge(); }, 60_000);
    },

    stop() {
        if (purgeTimer != null) clearInterval(purgeTimer);
        purgeTimer = null;
    }
});
