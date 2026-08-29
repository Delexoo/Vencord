/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

import { Delexo } from "../_delexo/author";
import { createShareSync, patchOwnBio, setOwnButtonShare, startLiveShare, stopLiveShare } from "../_delexo/liveShare";
import {
    isHttpUrl,
    writeShare,
    type ButtonShare,
} from "./share";

const settings = definePluginSettings({
    label: {
        type: OptionType.STRING,
        description: "Name shown when someone hovers the profile button",
        default: "Donate",
        placeholder: "Donate",
        onChange() { onShareChange(); }
    },
    url: {
        type: OptionType.STRING,
        description: "Link opened when someone clicks the button",
        default: "",
        placeholder: "https://buy.stripe.com/...",
        isValid(value: string) {
            if (!value.trim()) return true;
            return isHttpUrl(value) || "Must be a valid http(s) URL.";
        },
        onChange() { onShareChange(); }
    },
    showHeart: {
        type: OptionType.BOOLEAN,
        description: "Show a heart on the button and in the hover tooltip",
        default: true,
        onChange() { onShareChange(); }
    }
});

function currentShare(): ButtonShare | null {
    const label = String(settings.store.label ?? "").trim();
    const url = String(settings.store.url ?? "").trim();
    if (!label || !isHttpUrl(url)) return null;
    return {
        label: label.slice(0, 32),
        url,
        heart: settings.store.showHeart !== false
    };
}

function onShareChange() {
    setOwnButtonShare(currentShare());
    scheduleShare();
}

async function syncShareToBio() {
    const data = currentShare();
    setOwnButtonShare(data);
    try {
        await patchOwnBio(bio => writeShare(bio, data));
    } catch (e) {
        console.error("[ProfileButton] failed to save profile button share", e);
    }
}

const scheduleShare = createShareSync(syncShareToBio);

export default definePlugin({
    name: "ProfileButton",
    description: "Add a button in the profile badge row. Anyone with Vencord installed can see it and open your link.",
    authors: [Delexo],
    tags: ["Appearance"],
    searchTerms: ["donate", "button", "profile", "link", "kofi", "stripe", "paypal", "heart", "badge"],
    enabledByDefault: true,
    requiresRestart: false,
    settings,

    start() {
        startLiveShare();
        setOwnButtonShare(currentShare());
        scheduleShare();
    },

    flux: {
        CONNECTION_OPEN() {
            setOwnButtonShare(currentShare());
            scheduleShare();
        }
    },

    stop() {
        setOwnButtonShare(null);
        stopLiveShare();
    }
});
