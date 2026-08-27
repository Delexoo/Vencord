/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { ErrorCard } from "@components/ErrorCard";
import { ExpandableSection } from "@components/ExpandableCard";
import { Flex } from "@components/Flex";
import { Link } from "@components/Link";
import { isTruthy } from "@utils/guards";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { findByCodeLazy, findComponentByCodeLazy } from "@webpack";
import { ApplicationAssetUtils, Button, FluxDispatcher, Forms, UserStore } from "@webpack/common";

import { Delexo } from "../_delexo/author";
import { resolveTemplate, TimestampMode } from "./markdown";
import { PresenceSettings } from "./Settings";
import { loadPresetIntoStore, refreshPresets } from "./store";
import managedStyle from "./style.css?managed";

const useProfileThemeStyle = findByCodeLazy("profileThemeStyle:", "--profile-gradient-primary-color");
const ActivityView = findComponentByCodeLazy(".party?(0", "USER_PROFILE_ACTIVITY");
const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

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

        const details = resolveTemplate(store.details, activeName);
        const state = resolveTemplate(store.state, activeName);

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

export default definePlugin({
    name: "AdvancedRichPresence",
    description: "CustomRPC with Markdown presets you can create, update, duplicate, and delete",
    tags: ["Activity", "Customisation"],
    searchTerms: ["rpc", "rich presence", "preset", "markdown", "harvard", "customrpc", "delexo"],
    authors: [Delexo],
    dependencies: ["UserSettingsAPI"],
    requiresRestart: false,
    settings,
    managedStyle,

    async start() {
        try {
            const list = await refreshPresets();
            if (settings.store.activeFile)
                await loadPresetIntoStore(settings.store, settings.store.activeFile);
            else if (list[0] && !settings.store.appName)
                await loadPresetIntoStore(settings.store, list[0].fileName);
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

    settingsAboutComponent: () => {
        const [activity] = useAwaiter(createActivity, { fallbackValue: undefined, deps: Object.values(settings.store) });
        const gameActivityEnabled = ShowCurrentGame.useSetting();
        const { profileThemeStyle } = useProfileThemeStyle({});

        return (
            <>
                {!gameActivityEnabled && (
                    <ErrorCard
                        className={classes(Margins.top16, Margins.bottom16)}
                        style={{ padding: "1em" }}
                    >
                        <Forms.FormTitle>Notice</Forms.FormTitle>
                        <Forms.FormText>Activity Sharing isn't enabled, people won't be able to see your custom rich presence!</Forms.FormText>

                        <Button
                            color={Button.Colors.TRANSPARENT}
                            className={Margins.top8}
                            onClick={() => ShowCurrentGame.updateSetting(true)}
                        >
                            Enable
                        </Button>
                    </ErrorCard>
                )}

                <div style={{ width: "284px", ...profileThemeStyle, marginTop: 8, borderRadius: 8, background: "var(--background-mod-muted)" }}>
                    {activity && <ActivityView
                        activity={activity}
                        user={UserStore.getCurrentUser()}
                        currentUser={UserStore.getCurrentUser()}
                    />}
                </div>

                <ExpandableSection
                    className={classes(Margins.top8, "vc-arp-fold")}
                    renderContent={() => (
                        <Flex flexDirection="column" gap="8px">
                            <Forms.FormText>
                                Create an app in the <Link href="https://discord.com/developers/applications">Developer Portal</Link> for an Application ID. Upload images there for asset keys, or use a direct <Link href="https://imgur.com">Imgur</Link> link (right-click → Copy image address).
                            </Forms.FormText>
                            <Forms.FormText>
                                Presets are <code>.md</code> files in Documents → AdvancedRichPresence → presets. You cannot see your own buttons; others can. Fancy unicode fonts can hide the activity — use normal letters.
                            </Forms.FormText>
                            <Forms.FormText>
                                Text lines accept {"{time}"}, {"{date}"}, and {"{preset}"}.
                            </Forms.FormText>
                        </Flex>
                    )}
                >
                    Setup tips
                </ExpandableSection>
            </>
        );
    }
});
