/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelRTCStore, UserStore, VoiceStateStore } from "@webpack/common";

import { Delexo } from "../_delexo/author";

const settings = definePluginSettings({
    hideProfile: {
        type: OptionType.BOOLEAN,
        description: "Hide your profile from the voice list and call grid on this client",
        default: true,
        onChange() { refresh(); }
    }
});

type Wrapped = {
    store: Record<string, unknown>;
    key: string;
    original: (...args: unknown[]) => unknown;
};

const wraps: Wrapped[] = [];

function selfId() {
    try {
        return UserStore.getCurrentUser()?.id ?? "";
    } catch {
        return "";
    }
}

function hiding() {
    return settings.store.hideProfile && Boolean(selfId());
}

function omitUser<T extends Record<string, unknown>>(map: T | null | undefined, userId: string): T {
    if (!map || !userId || !(userId in map)) return map as T;
    const next = { ...map };
    delete next[userId];
    return next as T;
}

function omitParticipant(list: unknown, userId: string) {
    if (!Array.isArray(list) || !userId) return list;
    return list.filter(item => {
        const p = item as { id?: string; user?: { id?: string; }; };
        const id = p?.user?.id || p?.id;
        return id !== userId;
    });
}

function wrap(
    store: object | null | undefined,
    key: string,
    apply: (result: unknown, args: unknown[]) => unknown
) {
    if (!store || wraps.some(w => w.store === store && w.key === key)) return;
    const original = (store as Record<string, unknown>)[key];
    if (typeof original !== "function") return;
    const bound = original.bind(store) as (...args: unknown[]) => unknown;
    wraps.push({ store: store as Record<string, unknown>, key, original: bound });
    (store as Record<string, unknown>)[key] = (...args: unknown[]) => apply(bound(...args), args);
}

function unwrapAll() {
    for (const item of wraps)
        item.store[item.key] = item.original;
    wraps.length = 0;
}

function refresh() {
    try { VoiceStateStore.emitChange(); } catch { /* ignore */ }
    try { ChannelRTCStore.emitChange(); } catch { /* ignore */ }
}

function hookStores() {
    unwrapAll();

    wrap(VoiceStateStore, "getVoiceStatesForChannel", result =>
        hiding() ? omitUser(result as Record<string, unknown>, selfId()) : result
    );
    wrap(VoiceStateStore, "getVideoVoiceStatesForChannel", result =>
        hiding() ? omitUser(result as Record<string, unknown>, selfId()) : result
    );
    wrap(VoiceStateStore, "getVoiceStates", result =>
        hiding() ? omitUser(result as Record<string, unknown>, selfId()) : result
    );
    wrap(VoiceStateStore, "getUsersWithVideo", result => {
        if (!hiding() || !(result instanceof Set)) return result;
        const next = new Set(result);
        next.delete(selfId());
        return next;
    });

    wrap(ChannelRTCStore, "getParticipants", result =>
        hiding() ? omitParticipant(result, selfId()) : result
    );
    wrap(ChannelRTCStore, "getFilteredParticipants", result =>
        hiding() ? omitParticipant(result, selfId()) : result
    );
    wrap(ChannelRTCStore, "getVideoParticipants", result =>
        hiding() ? omitParticipant(result, selfId()) : result
    );
    wrap(ChannelRTCStore, "getSpeakingParticipants", result =>
        hiding() ? omitParticipant(result, selfId()) : result
    );
    wrap(ChannelRTCStore, "getUserParticipantCount", (result, args) => {
        if (!hiding() || typeof result !== "number") return result;
        const channelId = String(args[0] ?? "");
        const me = selfId();
        if (!channelId || !me) return result;
        try {
            if (VoiceStateStore.getVoiceStateForUser?.(me)?.channelId !== channelId)
                return result;
        } catch {
            return result;
        }
        return Math.max(0, result - 1);
    });
}

export default definePlugin({
    name: "Spoof Join",
    description: "Join voice without showing your profile in the channel list or call grid on your screen. You stay connected so you can test Discord’s connection UI and layouts. Other people still see you.",
    authors: [Delexo],
    tags: ["Voice", "Utility"],
    searchTerms: ["spoof", "join", "voice", "hide", "profile", "ghost", "test"],
    settings,

    start() {
        hookStores();
        refresh();
    },

    stop() {
        unwrapAll();
        refresh();
    },

    flux: {
        CONNECTION_OPEN() {
            hookStores();
            refresh();
        },
        VOICE_CHANNEL_SELECT() {
            refresh();
        },
        RTC_CONNECTION_STATE() {
            refresh();
        }
    }
});
