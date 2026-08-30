/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Link } from "@components/Link";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityFlags, ActivityType } from "@vencord/discord-types/enums";
import { findByCodeLazy } from "@webpack";
import { ApplicationAssetUtils, Clickable, FluxDispatcher, Forms, ReactDOM, useLayoutEffect, UserStore, useState } from "@webpack/common";

import { Delexo } from "../_delexo/author";
import { resolveTemplate, TimestampMode } from "./markdown";
import { PresenceSettings } from "./Settings";
import { DEFAULT_RPC_APP_ID, loadPresetIntoStore, refreshPresets } from "./store";
import managedStyle from "./style.css?managed";

const SOCKET_ID = "AdvancedRichPresence";
const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;
const fetchApplicationsRPC = findByCodeLazy('"Invalid Origin"', ".application");
const knownApps: Record<string, true> = {};
let rpcGen = 0;
let rpcTimer: ReturnType<typeof setInterval> | null = null;
let rpcDelay: ReturnType<typeof setTimeout> | null = null;
let lastRpcSig = "";

export { TimestampMode };

function isHttp(value?: string) {
    return Boolean(value && /^https?:\/\//i.test(value.trim()));
}

function isAppId(value?: string) {
    return Boolean(value && /^\d{16,21}$/.test(value.trim()));
}

function isProxiedAsset(key: string) {
    return Boolean(key) && !/^https?:\/\//i.test(key);
}

function resolveAppId(): string {
    const raw = String(settings.store.appID ?? "").trim();
    return isAppId(raw) ? raw : DEFAULT_RPC_APP_ID;
}

async function ensureApplication(appId: string) {
    if (!isAppId(appId) || knownApps[appId]) return;
    try {
        const socket: Record<string, unknown> = {};
        await fetchApplicationsRPC(socket, appId);
        knownApps[appId] = true;
    } catch {
        knownApps[appId] = true;
    }
}

async function getApplicationAsset(key: string, appId: string): Promise<string | undefined> {
    const raw = String(key ?? "").trim();
    if (!raw) return undefined;
    if (isProxiedAsset(raw) && !isHttp(raw)) return raw;
    if (!isAppId(appId)) return undefined;
    try {
        const id = String((await ApplicationAssetUtils.fetchAssetIds(appId, [raw]))[0] ?? "");
        if (id && isProxiedAsset(id)) return id;
    } catch { /* Discord rejects raw http assets on the gateway */ }
    return undefined;
}

function shareActivity() {
    try {
        if (ShowCurrentGame.getSetting() === false)
            ShowCurrentGame.updateSetting(true);
    } catch { /* UserSettingsAPI may not be ready yet */ }
}

function stopRpcLoop() {
    if (rpcDelay) {
        clearTimeout(rpcDelay);
        rpcDelay = null;
    }
    if (rpcTimer) {
        clearInterval(rpcTimer);
        rpcTimer = null;
    }
}

function startRpcLoop() {
    stopRpcLoop();
    rpcDelay = setTimeout(() => {
        rpcDelay = null;
        void setRpc();
    }, 2000);
    rpcTimer = setInterval(() => void setRpc(), 15000);
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
        const appId = resolveAppId();

        const activity: Activity = {
            application_id: appId,
            name: appName,
            state,
            details,
            type: type ?? ActivityType.PLAYING,
            flags: ActivityFlags.INSTANCE,
        };

        await ensureApplication(appId);

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

        if (isHttp(detailsURL)) activity.details_url = detailsURL;
        if (isHttp(stateURL)) activity.state_url = stateURL;

        const buttons: string[] = [];
        const buttonUrls: string[] = [];
        if (buttonOneText && isHttp(buttonOneURL)) {
            buttons.push(buttonOneText);
            buttonUrls.push(String(buttonOneURL).trim());
        }
        if (buttonTwoText && isHttp(buttonTwoURL)) {
            buttons.push(buttonTwoText);
            buttonUrls.push(String(buttonTwoURL).trim());
        }
        if (buttons.length) {
            activity.buttons = buttons;
            activity.metadata = { button_urls: buttonUrls };
        }

        if (imageBig) {
            const large_image = await getApplicationAsset(String(imageBig), appId);
            if (large_image) {
                activity.assets = {
                    large_image,
                    large_text: imageBigTooltip || undefined,
                    large_url: isHttp(imageBigURL) ? imageBigURL : undefined
                };
            }
        }

        if (imageSmall) {
            const small_image = await getApplicationAsset(String(imageSmall), appId);
            if (small_image) {
                activity.assets = {
                    ...activity.assets,
                    small_image,
                    small_text: imageSmallTooltip || undefined,
                    small_url: isHttp(imageSmallURL) ? imageSmallURL : undefined
                };
            }
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
    const gen = ++rpcGen;
    try {
        const activity = disable ? null : (await createActivity() ?? null);
        if (gen !== rpcGen) return;
        const sig = disable ? "" : JSON.stringify(activity);
        if (!disable && sig === lastRpcSig) return;
        lastRpcSig = sig;
        if (activity) shareActivity();
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity,
            socketId: SOCKET_ID,
        });
    } catch (e) {
        if (gen !== rpcGen) return;
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
                Discord only shows this to other people if an App ID is attached. Leave App ID blank and we attach one automatically. Optional <Link href="https://discord.com/developers/applications">your own App ID</Link> if you upload images in the Developer Portal. Otherwise paste a direct <Link href="https://imgur.com">Imgur</Link> image address.
            </Forms.FormText>
            <Forms.FormText>
                Statuses are saved as files in Documents → AdvancedRichPresence. You won’t see your own buttons; other people will. Stay Online or Idle — Invisible hides activity.
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
    searchTerms: ["rpc", "rich presence", "preset", "markdown", "customrpc", "delexo", "status", "harvard", "onlyfans", "camera"],
    authors: [Delexo],
    dependencies: ["UserSettingsAPI"],
    requiresRestart: false,
    settingsModalSize: "xl",
    settings,
    managedStyle,

    async start() {
        try {
            FluxDispatcher.dispatch({
                type: "LOCAL_ACTIVITY_UPDATE",
                activity: null,
                socketId: "HarvardOnline",
            });
        } catch { /* leftover from the old Harvard Online plugin */ }
        settings.store.rpcEnabled = true;
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
        shareActivity();
        await setRpc().catch(e => console.error("[AdvancedRichPresence] start failed", e));
        startRpcLoop();
    },

    stop() {
        stopRpcLoop();
        rpcGen++;
        void setRpc(true).catch(e => console.error("[AdvancedRichPresence] stop failed", e));
    },

    flux: {
        CONNECTION_OPEN() {
            shareActivity();
            void setRpc();
            startRpcLoop();
        },
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
