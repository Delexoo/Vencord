/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Link } from "@components/Link";
import { isTruthy } from "@utils/guards";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, Clickable, FluxDispatcher, Forms, ReactDOM, useLayoutEffect, UserStore, useState } from "@webpack/common";

import { Delexo } from "../_delexo/author";
import { resolveTemplate, TimestampMode } from "./markdown";
import { PresenceSettings } from "./Settings";
import { loadPresetIntoStore, refreshPresets } from "./store";
import managedStyle from "./style.css?managed";

const SOCKET_ID = "AdvancedRichPresence";

export { TimestampMode };

async function getApplicationAsset(key: string): Promise<string> {
    try {
        if (!settings.store.appID) return key;
        return (await ApplicationAssetUtils.fetchAssetIds(settings.store.appID, [key]))[0] ?? key;
    } catch {
        return key;
    }
}

export const settings = definePluginSettings({
    config: {
        type: OptionType.COMPONENT,
        component: PresenceSettings
    },
}).withPrivateSettings<{
    appID?: string;
    appName?: string;
    details?: string;
    detailsURL?: string;
    state?: string;
    stateURL?: string;
    type?: ActivityType;
    streamLink?: string;
    timestampMode?: TimestampMode;
    startTime?: number;
    endTime?: number;
    imageBig?: string;
    imageBigURL?: string;
    imageBigTooltip?: string;
    imageSmall?: string;
    imageSmallURL?: string;
    imageSmallTooltip?: string;
    buttonOneText?: string;
    buttonOneURL?: string;
    buttonTwoText?: string;
    buttonTwoURL?: string;
    partySize?: number;
    partyMaxSize?: number;
    partyId?: string;
    notes?: string;
    rpcEnabled?: boolean;
    activeFile?: string;
    activeName?: string;
}>();

export async function createActivity(): Promise<Activity | undefined> {
    try {
        const { store } = settings;
        if (store.rpcEnabled === false) return;

        const {
            appID,
            appName,
            detailsURL,
            stateURL,
            type,
            streamLink,
            startTime,
            endTime,
            imageBig,
            imageBigURL,
            imageBigTooltip,
            imageSmall,
            imageSmallURL,
            imageSmallTooltip,
            buttonOneText,
            buttonOneURL,
            buttonTwoText,
            buttonTwoURL,
            partyMaxSize,
            partySize,
            partyId,
            timestampMode,
            activeName,
        } = store;

        if (!appName) return;

        const me = UserStore.getCurrentUser();
        const userName = me?.globalName || me?.username;
        const details = resolveTemplate(store.details, activeName, userName);
        const state = resolveTemplate(store.state, activeName, userName);

        const activity: Activity = {
            application_id: appID || "0",
            name: appName,
            state,
            details,
            type: type ?? ActivityType.PLAYING,
            flags: 1 << 0,
        };

        if (type === ActivityType.STREAMING) activity.url = streamLink;

        const mode = timestampMode ?? TimestampMode.TIME;
        switch (mode) {
            case TimestampMode.NOW:
                activity.timestamps = { start: Date.now() };
                break;
            case TimestampMode.TIME: {
                const now = new Date();
                activity.timestamps = {
                    start: Date.now() - (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000
                };
                break;
            }
            case TimestampMode.CUSTOM:
                if (startTime || endTime) {
                    activity.timestamps = {};
                    if (startTime) activity.timestamps.start = Number(startTime);
                    if (endTime) activity.timestamps.end = Number(endTime);
                }
                break;
            case TimestampMode.NONE:
                break;
            default: {
                const _exhaustive: never = mode;
                void _exhaustive;
                break;
            }
        }

        if (detailsURL) activity.details_url = detailsURL;
        if (stateURL) activity.state_url = stateURL;

        if (buttonOneText) {
            activity.buttons = [buttonOneText, buttonTwoText].filter(isTruthy);
            activity.metadata = {
                button_urls: [buttonOneURL, buttonTwoURL].filter(isTruthy)
            };
        }

        if (imageBig) {
            activity.assets = {
                large_image: await getApplicationAsset(String(imageBig)),
                large_text: imageBigTooltip || undefined,
                large_url: imageBigURL || undefined
            };
        }

        if (imageSmall) {
            activity.assets = {
                ...activity.assets,
                small_image: await getApplicationAsset(String(imageSmall)),
                small_text: imageSmallTooltip || undefined,
                small_url: imageSmallURL || undefined
            };
        }

        if (partyId || (partyMaxSize && partySize)) {
            activity.party = {};
            if (partyId) activity.party.id = String(partyId);
            const size = Number(partySize);
            const max = Number(partyMaxSize);
            if (size && max) activity.party.size = [size, max];
        }

        for (const k in activity) {
            if (k === "type") continue;
            const v = activity[k];
            if (!v || v.length === 0) delete activity[k];
        }

        return activity;
    } catch (e) {
        console.error("[AdvancedRichPresence] createActivity failed", e);
        return undefined;
    }
}

export async function setRpc(disable?: boolean) {
    try {
        const activity = await createActivity();
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: !disable ? activity ?? null : null,
            socketId: SOCKET_ID,
        });
    } catch (e) {
        console.error("[AdvancedRichPresence] setRpc failed", e);
        try {
            FluxDispatcher.dispatch({
                type: "LOCAL_ACTIVITY_UPDATE",
                activity: null,
                socketId: SOCKET_ID,
            });
        } catch { /* never throw into Discord */ }
    }
}

function SetupTips() {
    const [open, setOpen] = useState(false);
    const [tagRow, setTagRow] = useState<HTMLElement | null>(null);
    const [infoWrap, setInfoWrap] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        const tags = document.querySelector<HTMLElement>(".vc-plugin-modal-tags");
        setTagRow(tags);
        setInfoWrap(tags?.parentElement ?? null);
    }, []);

    const pill = (
        <Clickable
            className={classes("vc-arp-tips-toggle", tagRow && "vc-plugin-modal-tag", open && "vc-arp-tips-on")}
            onClick={() => setOpen(v => !v)}
        >
            <span>Setup tips</span>
            <span className="vc-arp-tips-caret" aria-hidden>{open ? "▾" : "▸"}</span>
        </Clickable>
    );

    const body = open && (
        <div className="vc-arp-tips-body">
            <Forms.FormText>
                Optional <Link href="https://discord.com/developers/applications">App ID</Link> from the Developer Portal if you upload images there. Otherwise paste a direct <Link href="https://imgur.com">Imgur</Link> image address.
            </Forms.FormText>
            <Forms.FormText>
                Statuses are saved as files in Documents → AdvancedRichPresence. You won’t see your own buttons; other people will.
            </Forms.FormText>
            <Forms.FormText>
                In Line 1 or Line 2 you can type {"{user}"} (your name), {"{time}"}, {"{date}"}, or {"{preset}"}.
            </Forms.FormText>
        </div>
    );

    return (
        <>
            {tagRow ? ReactDOM.createPortal(pill, tagRow) : <div className="vc-arp-tips">{pill}</div>}
            {body && (infoWrap ? ReactDOM.createPortal(body, infoWrap) : body)}
        </>
    );
}

export default definePlugin({
    name: "AdvancedRichPresence",
    description: "Show a custom status on your profile. Save different statuses and switch between them.",
    tags: ["Activity", "Customisation"],
    searchTerms: ["rpc", "rich presence", "preset", "markdown", "customrpc", "delexo", "status"],
    authors: [Delexo],
    dependencies: ["UserSettingsAPI"],
    requiresRestart: false,
    settings,
    managedStyle,

    async start() {
        try {
            const list = await refreshPresets();
            const active = settings.store.activeFile;
            if (active && await loadPresetIntoStore(settings.store, active)) {
                /* keep current */
            } else if (list[0] && !settings.store.appName) {
                await loadPresetIntoStore(settings.store, list[0].fileName);
            }
        } catch (e) {
            console.error("[AdvancedRichPresence] preset load failed", e);
        }
        void setRpc().catch(e => console.error("[AdvancedRichPresence] start failed", e));
    },

    stop() {
        void setRpc(true).catch(e => console.error("[AdvancedRichPresence] stop failed", e));
    },

    patches: [
        {
            find: ".USER_PROFILE_ACTIVITY_BUTTONS),",
            replacement: {
                match: /.getId\(\)===\i.id/,
                replace: "$& && false"
            }
        }
    ],

    settingsAboutComponent: () => (
        <>
            <div className="vc-arp-about-anchor" hidden />
            <SetupTips />
        </>
    )
});
