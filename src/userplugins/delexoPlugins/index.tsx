/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin, { StartAt } from "@utils/types";

import Plugins from "~plugins";

import { Delexo } from "../_delexo/author";
import DelexoPluginsTab from "./PluginsTab";
import managedStyle from "./style.css?managed";

type SettingsEntryOptions = {
    key: string;
    title: string;
    panelTitle?: string;
    Component: unknown;
    Icon: unknown;
};

type SettingsPluginApi = {
    buildEntry(options: SettingsEntryOptions): unknown;
};

let originalBuildEntry: ((options: SettingsEntryOptions) => unknown) | null = null;

function settingsApi() {
    return Plugins.Settings as SettingsPluginApi | undefined;
}

export default definePlugin({
    name: "DelexoPlugins",
    description: "Shows Delexo plugins in their own section above other plugins.",
    authors: [Delexo],
    tags: ["Appearance"],
    enabledByDefault: true,
    hidden: true,
    startAt: StartAt.Init,
    managedStyle,

    start() {
        const settings = settingsApi();
        if (!settings?.buildEntry || originalBuildEntry) return;

        originalBuildEntry = settings.buildEntry.bind(settings);
        settings.buildEntry = (options: SettingsEntryOptions) => {
            if (options.key === "vencord_plugins") {
                return originalBuildEntry!({
                    ...options,
                    Component: DelexoPluginsTab
                });
            }
            return originalBuildEntry!(options);
        };
    },

    stop() {
        const settings = settingsApi();
        if (settings && originalBuildEntry) {
            settings.buildEntry = originalBuildEntry;
        }
        originalBuildEntry = null;
    }
});
