/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Delexo } from "../_delexo/author";
import { mutationClassMatches, scheduleOnce } from "../_delexo/idle";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { createRoot } from "@webpack/common";
import type { Root } from "react-dom/client";

import { MentionsNavItem, openMentionsPage, renderMentionsNav, settings } from "./MentionsPage";
import managedStyle from "./style.css?managed";

export { settings };

const HOST_ID = "vc-mentions-dom-nav";
const NAV_RE = /privateChannels|quests|sidebar/;

let domHost: HTMLDivElement | null = null;
let domRoot: Root | null = null;
let domObserver: MutationObserver | null = null;
const placeNav = scheduleOnce(150);

let cachedQuests: HTMLElement | null = null;

function findQuestsRow(): HTMLElement | null {
    if (cachedQuests?.isConnected) return cachedQuests;
    cachedQuests = null;
    const nodes = document.querySelectorAll<HTMLElement>(
        '[class*="privateChannels"] [class*="link"], [class*="privateChannels"] [class*="channel"], nav [class*="interactive"]'
    );
    for (const el of nodes) {
        const label = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/^quests$/i.test(label)) {
            cachedQuests = el.closest<HTMLElement>('[class*="channel"], [class*="link"], [role="listitem"], div') || el;
            return cachedQuests;
        }
    }
    const byAria = document.querySelector<HTMLElement>('[aria-label="Quests" i]');
    if (byAria) {
        cachedQuests = byAria.closest<HTMLElement>('[class*="channel"], [class*="link"], div') || byAria;
        return cachedQuests;
    }
    return null;
}

function removeAllMentionsHosts() {
    domRoot?.unmount();
    domRoot = null;
    domHost = null;

    for (const el of Array.from(document.querySelectorAll(`#${HOST_ID}, .vc-mentions-dom-host, .vc-mentions-nav`))) {
        // Only remove hosts we injected; leave Discord's own rows alone
        if (el.id === HOST_ID || el.classList.contains("vc-mentions-dom-host")) {
            el.remove();
        }
    }
}

function removeDomNav() {
    removeAllMentionsHosts();
}

function placeDomNav() {
    const quests = findQuestsRow();
    if (!quests?.parentElement) {
        removeAllMentionsHosts();
        return;
    }

    const parent = quests.parentElement;

    // Already correctly placed; keep the single instance
    if (
        domHost?.isConnected &&
        domHost.parentElement === parent &&
        domHost.previousElementSibling === quests &&
        document.querySelectorAll(`#${HOST_ID}`).length === 1
    ) {
        return;
    }

    removeAllMentionsHosts();

    domHost = document.createElement("div");
    domHost.id = HOST_ID;
    domHost.className = "vc-mentions-dom-host";

    if (quests.nextSibling)
        parent.insertBefore(domHost, quests.nextSibling);
    else
        parent.appendChild(domHost);

    domRoot = createRoot(domHost);
    domRoot.render(
        <ErrorBoundary noop>
            <MentionsNavItem />
        </ErrorBoundary>
    );
}

function queueDomNav() {
    placeNav.run(() => {
        try { placeDomNav(); } catch { /* ignore */ }
    });
}

export default definePlugin({
    name: "Mentions",
    description: "Adds a Mentions item under Quests that opens a page of every server/DM where you were @mentioned",
    tags: ["Chat", "Utility"],
    searchTerms: ["mentions", "inbox", "notify", "@", "ping", "delexo"],
    authors: [Delexo],
    requiresRestart: false,
    settings,
    managedStyle,

    // Keep renderMentionsNav exported for compatibility; do not patch Discord nav.
    // DOM injection alone avoids duplicate Mentions rows from overlapping patches.
    renderMentionsNav,
    MentionsNavItem,
    openMentionsPage,

    start() {
        removeAllMentionsHosts();
        queueDomNav();
        domObserver = new MutationObserver(records => {
            if (mutationClassMatches(records, NAV_RE)) queueDomNav();
        });
        domObserver.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        placeNav.cancel();
        cachedQuests = null;
        domObserver?.disconnect();
        domObserver = null;
        removeDomNav();
    }
});
