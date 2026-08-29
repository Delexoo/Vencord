/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { getUserSettingLazy } from "@api/UserSettings";
import definePlugin from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityFlags, ActivityType } from "@vencord/discord-types/enums";
import { findByCodeLazy } from "@webpack";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

import { Delexo } from "../_delexo/author";

const SOCKET_ID = "HarvardOnline";
const APP_ID = "1260139887504392203";
const APP_NAME = "Harvard Online";
const DETAILS = "Cybersecurity: Managing Risk in the Information Age";
const DETAILS_URL = "https://harvardonline.harvard.edu/";
const LARGE_IMAGE = "https://static-prod.logosoftwear.com/img/applications/library/design-tips/the-meanings-of-20-university-logos/harvard-logo.jpg";
const LARGE_TEXT = "Playing Harvard Online on Windows 11";
const SMALL_IMAGE = "https://media3.giphy.com/media/v1.Y2lkPTZjMDliOTUyNml6b2J2NnVvdWczNGlrZmIzcTZkOWNkczU4eHc5dTVxMmd4aHphciZlcD12MV9zdGlja2Vyc19zZWFyY2gmY3Q9cw/ymOQcf85Q5zrkBrhPM/source.gif";
const SMALL_TEXT = "Verified";
const BUTTON_TEXT = "Learn More";
const BUTTON_URL = "https://harvardonline.harvard.edu/";

const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;
const fetchApplicationsRPC = findByCodeLazy('"Invalid Origin"', ".application");
const knownApps: Record<string, true> = {};
let rpcGen = 0;

function isAppId(value?: string) {
    return Boolean(value && /^\d{16,21}$/.test(value.trim()));
}

function isProxiedAsset(key: string) {
    return Boolean(key) && !/^https?:\/\//i.test(key);
}

function elapsedSinceMidnight() {
    const now = new Date();
    return Date.now() - (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000;
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

async function getApplicationAsset(key: string): Promise<string | undefined> {
    const raw = String(key ?? "").trim();
    if (!raw) return undefined;
    try {
        const id = String((await ApplicationAssetUtils.fetchAssetIds(APP_ID, [raw]))[0] ?? "");
        if (id && isProxiedAsset(id)) return id;
    } catch { /* fall through */ }
    return isProxiedAsset(raw) ? raw : undefined;
}

function shareActivity() {
    try {
        if (ShowCurrentGame.getSetting() === false)
            ShowCurrentGame.updateSetting(true);
    } catch { /* UserSettingsAPI may not be ready yet */ }
}

function arpOwnsPresence() {
    return isPluginEnabled("AdvancedRichPresence");
}

async function createActivity(): Promise<Activity | undefined> {
    await ensureApplication(APP_ID);

    const activity: Activity = {
        name: APP_NAME,
        application_id: APP_ID,
        details: DETAILS,
        details_url: DETAILS_URL,
        type: ActivityType.PLAYING,
        flags: ActivityFlags.INSTANCE,
        timestamps: { start: elapsedSinceMidnight() },
        buttons: [BUTTON_TEXT],
        metadata: { button_urls: [BUTTON_URL] },
    };

    const large_image = await getApplicationAsset(LARGE_IMAGE);
    const small_image = await getApplicationAsset(SMALL_IMAGE);
    if (large_image || small_image) {
        activity.assets = {};
        if (large_image) {
            activity.assets.large_image = large_image;
            activity.assets.large_text = LARGE_TEXT;
        }
        if (small_image) {
            activity.assets.small_image = small_image;
            activity.assets.small_text = SMALL_TEXT;
        }
    }

    for (const k in activity) {
        if (k === "type") continue;
        const v = activity[k];
        if (!v || v.length === 0) delete activity[k];
    }

    return activity;
}

async function setRpc(disable = false) {
    if (!disable && arpOwnsPresence()) disable = true;
    const gen = ++rpcGen;
    try {
        const activity = disable ? null : (await createActivity() ?? null);
        if (gen !== rpcGen) return;
        if (activity) shareActivity();
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity,
            socketId: SOCKET_ID,
        });
    } catch (e) {
        if (gen !== rpcGen) return;
        console.error("[HarvardOnline] setRpc failed", e);
        try {
            FluxDispatcher.dispatch({
                type: "LOCAL_ACTIVITY_UPDATE",
                activity: null,
                socketId: SOCKET_ID,
            });
        } catch { /* never throw into Discord */ }
    }
}

export default definePlugin({
    name: "HarvardOnline",
    description: "Shows Playing Harvard Online on your profile.",
    tags: ["Activity"],
    searchTerms: ["rpc", "rich presence", "harvard", "customrpc"],
    authors: [Delexo],
    dependencies: ["UserSettingsAPI"],
    enabledByDefault: false,
    requiresRestart: false,

    async start() {
        await setRpc(arpOwnsPresence());
    },

    stop() {
        rpcGen++;
        void setRpc(true);
    },

    flux: {
        CONNECTION_OPEN() {
            void setRpc(arpOwnsPresence());
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
    ]
});
