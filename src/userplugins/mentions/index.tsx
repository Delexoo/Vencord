/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Delexo } from "../_delexo/author";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { createRoot } from "@webpack/common";
import type { Root } from "react-dom/client";

import { MentionsNavItem, openMentionsPage, renderMentionsNav, settings } from "./MentionsPage";
import managedStyle from "./style.css?managed";

export { settings };

const HOST_ID = "vc-mentions-dom-nav";

let domHost: HTMLDivElement | null = null;
let domRoot: Root | null = null;
let domObserver: MutationObserver | null = null;
let placeQueued = false;

function findQuestsRow(): HTMLElement | null {
    const nodes = document.querySelectorAll<HTMLElement>(
        '[class*="privateChannels"] [class*="link"], [class*="privateChannels"] [class*="channel"], nav [class*="interactive"]'
    );
    for (const el of nodes) {
        const label = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/^quests$/i.test(label))
            return el.closest<HTMLElement>('[class*="channel"], [class*="link"], [role="listitem"], div') || el;
    }
    const byAria = document.querySelector<HTMLElement>('[aria-label="Quests" i]');
    if (byAria) return byAria.closest<HTMLElement>('[class*="channel"], [class*="link"], div') || byAria;
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
    placeQueued = false;

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
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
        try { placeDomNav(); } catch { placeQueued = false; }
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
        domObserver = new MutationObserver(() => queueDomNav());
        domObserver.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        domObserver?.disconnect();
        domObserver = null;
        removeDomNav();
    }
});
