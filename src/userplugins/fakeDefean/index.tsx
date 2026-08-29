/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { getIntlMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import {
    ChannelStore,
    ContextMenuApi,
    MediaEngineStore,
    Menu,
    SelectedChannelStore,
    UserStore,
    VoiceStateStore
} from "@webpack/common";
import type { MouseEvent as ReactMouseEvent, UIEvent as ReactUIEvent } from "react";

import { Delexo } from "../_delexo/author";

const logger = new Logger("FakeDefean");
const Gateway = findByPropsLazy("getSocket");
const MediaEngineActions = findByPropsLazy("toggleSelfDeaf", "toggleSelfMute");

type DeafenChoice = "deafen" | "fake";
type GatewaySocket = {
    send: (op: number, data?: unknown, ...args: unknown[]) => unknown;
};

let fakeActive = false;
let ignoreAudioToggle = 0;
let hookedSocket: GatewaySocket | null = null;
let originalSend: GatewaySocket["send"] | null = null;
const restoreTimers: number[] = [];

function withIgnoredAudioToggle(action: () => void) {
    ignoreAudioToggle++;
    try {
        action();
    } finally {
        window.setTimeout(() => {
            ignoreAudioToggle = Math.max(0, ignoreAudioToggle - 1);
        }, 0);
    }
}

function isFakeActive() {
    return fakeActive;
}

function localDeaf(value: boolean) {
    return fakeActive ? false : value;
}

function gatewayMute(value: boolean) {
    return fakeActive ? true : value;
}

function gatewayDeaf(value: boolean) {
    return fakeActive ? true : value;
}

function toggleDiscordDeaf() {
    MediaEngineActions.toggleSelfDeaf?.();
}

function clearRestoreTimers() {
    for (const id of restoreTimers) window.clearTimeout(id);
    restoreTimers.length = 0;
}

function restoreLocalHearing() {
    if (!fakeActive) return;
    try {
        MediaEngineStore.getMediaEngine()?.eachConnection?.(connection => {
            connection.setSelfDeaf?.(false);
        }, "default");
    } catch (e) {
        logger.error("failed to restore local hearing", e);
    }
}

function scheduleRestoreHearing() {
    if (!fakeActive) return;
    restoreLocalHearing();
    requestAnimationFrame(() => restoreLocalHearing());
    for (const ms of [50, 200, 600]) {
        restoreTimers.push(window.setTimeout(() => restoreLocalHearing(), ms));
    }
}

function hookGateway() {
    const socket = Gateway.getSocket?.() as GatewaySocket | undefined;
    if (!socket || typeof socket.send !== "function") return;
    if (hookedSocket === socket) return;
    unhookGateway();
    originalSend = socket.send.bind(socket);
    hookedSocket = socket;
    socket.send = (op: number, data?: unknown, ...args: unknown[]) => {
        if (op === 4 && fakeActive && data && typeof data === "object") {
            return originalSend!(op, { ...data, self_mute: true, self_deaf: true }, ...args);
        }
        return originalSend!(op, data, ...args);
    };
}

function unhookGateway() {
    if (hookedSocket && originalSend) hookedSocket.send = originalSend;
    hookedSocket = null;
    originalSend = null;
}

function sendVoiceState(deaf: boolean) {
    hookGateway();
    const socket = Gateway.getSocket?.() as GatewaySocket | undefined;
    const channelId = SelectedChannelStore.getVoiceChannelId?.();
    if (!socket || !channelId) return;

    const channel = ChannelStore.getChannel(channelId);
    try {
        socket.send(4, {
            guild_id: channel?.guild_id ?? null,
            channel_id: channelId,
            self_mute: deaf || MediaEngineStore.isSelfMute(),
            self_deaf: deaf || MediaEngineStore.isSelfDeaf(),
            self_video: MediaEngineStore.isVideoEnabled?.() ?? false,
            flags: 0
        });
    } catch (e) {
        logger.error("failed to send voice state", e);
    }
}

function startFakeDeafen() {
    fakeActive = true;
    hookGateway();
    withIgnoredAudioToggle(() => {
        if (!MediaEngineStore.isSelfDeaf()) toggleDiscordDeaf();
    });
    sendVoiceState(true);
    scheduleRestoreHearing();
}

function stopFakeDeafen(shouldToggle = true) {
    fakeActive = false;
    clearRestoreTimers();
    withIgnoredAudioToggle(() => {
        if (shouldToggle && MediaEngineStore.isSelfDeaf()) toggleDiscordDeaf();
        else sendVoiceState(false);
    });
}

function applyChoice(choice: DeafenChoice) {
    switch (choice) {
        case "deafen":
            fakeActive = false;
            toggleDiscordDeaf();
            break;
        case "fake":
            startFakeDeafen();
            break;
        default: {
            const exhaustive: never = choice;
            return exhaustive;
        }
    }
}

function intlText(key: string) {
    try {
        const value = getIntlMessage(key);
        return typeof value === "string" ? value.toLowerCase().trim() : "";
    } catch {
        return "";
    }
}

function deafenLabels() {
    const labels = new Set(
        [
            "deafen",
            "undeafen",
            "defean",
            "undefean",
            intlText("DEAFEN"),
            intlText("UNDEAFEN"),
            intlText("SOUND_DEAFEN"),
            intlText("SOUND_UNDEAFEN")
        ].filter(Boolean)
    );
    return labels;
}

function buttonLabel(button: HTMLElement) {
    const labelledBy = button.getAttribute("aria-labelledby");
    const fromId = labelledBy ? document.getElementById(labelledBy)?.textContent : "";
    return [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        fromId
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .trim();
}

function isSelfDeafenButton(target: EventTarget | null) {
    if (!(target instanceof Element)) return false;
    if (target.closest("#vc-fake-deafean-menu, [class*='menu'][id*='fake-deafean']")) return false;

    const button = target.closest("button");
    if (!button) return false;

    const label = buttonLabel(button);
    if (!label) return false;
    if (/\b(server|member|members|guild)\b/.test(label)) return false;

    return [...deafenLabels()].some(text =>
        label === text || label.startsWith(`${text} `) || label.startsWith(`${text}(`)
    );
}

function currentlyDeafened() {
    if (fakeActive) return true;
    try {
        if (MediaEngineStore.isSelfDeaf()) return true;
        const me = UserStore.getCurrentUser()?.id;
        const channelId = SelectedChannelStore.getVoiceChannelId?.();
        if (!me || !channelId) return false;
        const state = VoiceStateStore.getVoiceStateForChannel?.(channelId);
        return !!(state?.selfDeaf || state?.deaf);
    } catch {
        return fakeActive;
    }
}

function onDeafenClick(event: MouseEvent) {
    if (event.button !== 0) return;
    if (!isSelfDeafenButton(event.target)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (currentlyDeafened()) {
        stopFakeDeafen(true);
        return;
    }

    ContextMenuApi.openContextMenu(event as unknown as ReactUIEvent, () => <DeafenChoiceMenu />);
}

function wrapDeafenClick(original: (...args: unknown[]) => unknown) {
    return (event?: ReactMouseEvent) => {
        if (event && event.button !== 0) {
            original();
            return;
        }

        if (currentlyDeafened()) {
            fakeActive = false;
            clearRestoreTimers();
            withIgnoredAudioToggle(() => original());
            return;
        }

        if (event) {
            event.preventDefault?.();
            event.stopPropagation?.();
            ContextMenuApi.openContextMenu(event, () => <DeafenChoiceMenu />);
            return;
        }

        original();
    };
}

function onOwnVoiceState(voiceStates?: { userId?: string; selfDeaf?: boolean; deaf?: boolean; }[]) {
    if (!fakeActive) return;
    hookGateway();
    scheduleRestoreHearing();

    const me = UserStore.getCurrentUser()?.id;
    if (!me || !voiceStates?.length) return;
    const mine = voiceStates.find(state => state.userId === me);
    if (mine && !mine.selfDeaf && !mine.deaf) sendVoiceState(true);
}

const DeafenChoiceMenu = ErrorBoundary.wrap(function DeafenChoiceMenu() {
    return (
        <Menu.Menu navId="vc-fake-deafean-menu" onClose={ContextMenuApi.closeContextMenu}>
            <Menu.MenuItem
                id="vc-fake-deafean-real"
                label="Defean"
                action={() => applyChoice("deafen")}
            />
            <Menu.MenuItem
                id="vc-fake-deafean-fake"
                label="Fake Defean"
                action={() => applyChoice("fake")}
            />
        </Menu.Menu>
    );
}, { noop: true });

export default definePlugin({
    name: "Fake Defean",
    description: "Click Deafen to choose regular deafen or Fake Defean. Fake looks deafened to everyone else, but you can still hear.",
    authors: [Delexo],
    tags: ["Voice", "Fun"],
    searchTerms: ["deafen", "defean", "fake deafen", "ghost", "headphones"],
    enabledByDefault: true,

    start() {
        hookGateway();
        document.addEventListener("click", onDeafenClick, true);
    },

    stop() {
        document.removeEventListener("click", onDeafenClick, true);
        clearRestoreTimers();
        if (fakeActive) {
            fakeActive = false;
            sendVoiceState(false);
        }
        unhookGateway();
    },

    flux: {
        CONNECTION_OPEN() {
            hookGateway();
            if (fakeActive) {
                sendVoiceState(true);
                scheduleRestoreHearing();
            }
        },
        AUDIO_TOGGLE_SELF_DEAF() {
            if (ignoreAudioToggle || !fakeActive) return;
            if (!MediaEngineStore.isSelfDeaf()) {
                fakeActive = false;
                clearRestoreTimers();
                return;
            }
            scheduleRestoreHearing();
        },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates?: { userId?: string; selfDeaf?: boolean; deaf?: boolean; }[]; }) {
            onOwnVoiceState(voiceStates);
        },
        RTC_CONNECTION_STATE() {
            if (!fakeActive) return;
            hookGateway();
            sendVoiceState(true);
            scheduleRestoreHearing();
        }
    },

    patches: [
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            noWarn: true,
            replacement: {
                match: /onClick:(\i)\.toggleSelfDeaf/,
                replace: "onClick:$self.wrapDeafenClick($1.toggleSelfDeaf)",
                noWarn: true
            }
        },
        {
            find: ".setSelfMute(",
            noWarn: true,
            replacement: {
                match: /(\i)\.setSelfDeaf\((\i(?:\.\w+)?)\)/,
                replace: "$1.setSelfDeaf($self.localDeaf($2))"
            }
        },
        {
            find: "}voiceStateUpdate(",
            noWarn: true,
            replacement: {
                match: /self_mute:([^,]+),self_deaf:([^,]+)/,
                replace: "self_mute:$self.gatewayMute($1),self_deaf:$self.gatewayDeaf($2)"
            }
        }
    ],

    wrapDeafenClick,
    localDeaf,
    gatewayMute,
    gatewayDeaf,
    isFakeActive
});
