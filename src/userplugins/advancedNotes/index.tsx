/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Delexo } from "../_delexo/author";
import { mutationClassMatches, scheduleOnce } from "../_delexo/idle";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { Button, Text, createRoot, useEffect, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

import { AdvancedNoteField, getNotesDirPath, listNotesCount, openAdvancedNoteModal, openNotesFolder } from "./NoteModal";
import managedStyle from "./style.css?managed";

const cl = classNameFactory("vc-advanced-note-");

function SettingsPanel() {
    const [dir, setDir] = useState("");
    const [count, setCount] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void getNotesDirPath().then(setDir);
        void listNotesCount().then(setCount);
    }, []);

    return (
        <div className={cl("settings")}>
            <Text variant="text-sm/normal" className={cl("hint")}>
                Notes save as <code>{"{username}.md"}</code> in Documents → AdvancedNotes.
                If they change their name, the file is renamed automatically.
            </Text>

            <div className={cl("path-box")} title={dir || undefined}>
                <code className={cl("path")}>{dir || "Loading…"}</code>
            </div>

            <div className={cl("meta-row")}>
                <Text variant="text-xs/medium" className={cl("meta")}>
                    {count == null
                        ? "…"
                        : count === 0
                            ? "No notes yet"
                            : `${count} note${count === 1 ? "" : "s"}`}
                </Text>
                <Button
                    size={Button.Sizes.SMALL}
                    disabled={busy || !dir}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            await openNotesFolder();
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    Open folder
                </Button>
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: SettingsPanel
    }
});

export const ProfileNotesButton = ErrorBoundary.wrap(function ProfileNotesButton(props: {
    user?: User | null;
    userId?: string;
    isSideBar?: boolean;
}) {
    const userId = props.user?.id || props.userId;
    if (!userId) return null;

    return (
        <div className={cl("profile-actions", props.isSideBar && "profile-actions-sidebar")}>
            <Button
                size={Button.Sizes.MEDIUM}
                color={Button.Colors.PRIMARY}
                className={cl("profile-btn")}
                onClick={() => openAdvancedNoteModal(userId)}
            >
                Advanced Notes
            </Button>
        </div>
    );
}, { noop: true });

function findUserIdNear(el: Element | null): string | null {
    let cur: Element | null = el;
    for (let i = 0; i < 24 && cur; i++) {
        const fiberKey = Object.keys(cur).find(k =>
            k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
        );
        let fiber: any = fiberKey ? (cur as any)[fiberKey] : null;
        for (let d = 0; d < 18 && fiber; d++, fiber = fiber.return) {
            const p = fiber.memoizedProps || fiber.pendingProps || {};
            if (p.user?.id) return String(p.user.id);
            if (p.userId) return String(p.userId);
            if (typeof p.id === "string" && /^\d{16,20}$/.test(p.id) && p.username) return p.id;
        }
        cur = cur.parentElement;
    }
    return null;
}

function findViewFullProfileButton(): HTMLElement | null {
    const roots = document.querySelectorAll<HTMLElement>(
        '[class*="userPopoutOuter"], [class*="userPopoutInner"], [class*="userProfileOuter"], [class*="biteSize"]'
    );
    for (const root of roots) {
        for (const el of root.querySelectorAll<HTMLElement>("button, [role='button']")) {
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (/^view full profile$/i.test(t)) return el;
        }
    }
    return null;
}

const PROFILE_UI_RE = /userProfile|userPopout|profilePanel|biteSize/;
const placeNotes = scheduleOnce(150);

let popoutHost: HTMLDivElement | null = null;
let popoutRoot: Root | null = null;
let popoutObserver: MutationObserver | null = null;

function removePopoutButton() {
    popoutRoot?.unmount();
    popoutRoot = null;
    popoutHost?.remove();
    popoutHost = null;
}

function findProfileButtonRow(viewFull: HTMLElement): HTMLElement {
    return (
        viewFull.closest<HTMLElement>('[class*="buttons"]') ||
        viewFull.closest<HTMLElement>('[class*="buttonContainer"]') ||
        viewFull.parentElement ||
        viewFull
    );
}

function placePopoutButton() {
    const viewFull = findViewFullProfileButton();
    if (!viewFull) {
        // popout closed
        if (popoutHost && !document.body.contains(popoutHost)) removePopoutButton();
        return;
    }

    const userId = findUserIdNear(viewFull);
    if (!userId) return;

    const row = findProfileButtonRow(viewFull);
    const mount = row.parentElement;
    if (!mount) return;

    if (popoutHost?.isConnected && popoutHost.previousElementSibling === row) {
        // already under the profile button row; remount if user changed
        const currentId = popoutHost.getAttribute("data-user-id");
        if (currentId === userId) return;
        removePopoutButton();
    } else {
        removePopoutButton();
    }

    popoutHost = document.createElement("div");
    popoutHost.id = "vc-advanced-note-popout-host";
    popoutHost.className = "vc-advanced-note-popout-host";
    popoutHost.setAttribute("data-user-id", userId);

    // Mount below the entire button row, not beside View Full Profile
    if (row.nextSibling)
        mount.insertBefore(popoutHost, row.nextSibling);
    else
        mount.appendChild(popoutHost);

    popoutRoot = createRoot(popoutHost);
    popoutRoot.render(<ProfileNotesButton userId={userId} />);
}

function normalizeText(s: string | null | undefined) {
    return (s ?? "").replace(/\s+/g, " ").trim();
}

function findFullProfileNoteSection(): HTMLElement | null {
    const profileRoot =
        document.querySelector<HTMLElement>('[class*="userProfileModal"]') ||
        document.querySelector<HTMLElement>('[class*="userProfileOuter"]') ||
        document.querySelector<HTMLElement>('[class*="profilePanel"]');

    if (!profileRoot) return null;
    const scope = profileRoot;
    let labelEl: HTMLElement | null = null;
    let fieldEl: HTMLElement | null = null;

    for (const el of scope.querySelectorAll<HTMLElement>(
        "span, div, h2, h3, label, p, button, [role='button']"
    )) {
        if (el.closest("#vc-advanced-note-popout-host, #vc-advanced-note-profile-host")) continue;
        if (el.children.length > 5) continue;

        const t = normalizeText(el.textContent);
        if (!labelEl && /^note \(only visible to you\)$/i.test(t)) labelEl = el;
        if (!fieldEl && /^click to add a note$/i.test(t)) fieldEl = el;
        if (labelEl && fieldEl) break;
    }

    if (!labelEl && !fieldEl) return null;

    if (labelEl && fieldEl) {
        let section: HTMLElement | null = labelEl.parentElement;
        for (let i = 0; i < 10 && section; i++) {
            if (section.contains(fieldEl)) return section;
            section = section.parentElement;
        }
    }

    let section: HTMLElement | null = labelEl ?? fieldEl;
    for (let i = 0; i < 6 && section?.parentElement; i++) {
        const parent = section.parentElement;
        const text = normalizeText(parent.textContent);
        if (/note.*only visible to you/i.test(text) && /click to add a note/i.test(text)) {
            return parent;
        }
        section = parent;
    }

    return labelEl?.parentElement ?? fieldEl?.parentElement ?? null;
}

function hideDefaultNoteUi(section: HTMLElement, keepHost: HTMLElement | null) {
    const hide = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return;
        if (keepHost && (el === keepHost || keepHost.contains(el) || el.contains(keepHost))) return;

        const t = normalizeText(el.textContent);
        const isNoteLabel = /^note \(only visible to you\)$/i.test(t);
        const isNotePlaceholder = /^click to add a note$/i.test(t);
        const isNoteInput = el.matches("textarea, [contenteditable='true'], input");

        if (isNoteLabel || isNotePlaceholder || isNoteInput) {
            el.style.display = "none";
            el.setAttribute("data-vc-advanced-note-hidden", "1");
        }
    };

    for (const child of Array.from(section.children)) {
        if (keepHost && child === keepHost) continue;
        hide(child);
    }

    let sib: Element | null = section.previousElementSibling;
    for (let i = 0; i < 2 && sib; i++, sib = sib.previousElementSibling) hide(sib);
}

let profileHost: HTMLDivElement | null = null;
let profileRoot: Root | null = null;

function removeProfileNoteButton() {
    profileRoot?.unmount();
    profileRoot = null;
    profileHost?.remove();
    profileHost = null;
}

function placeFullProfileNote() {
    const section = findFullProfileNoteSection();
    if (!section) {
        if (profileHost && !document.body.contains(profileHost)) removeProfileNoteButton();
        return;
    }

    const userId = findUserIdNear(section);
    if (!userId) return;

    const profileScope =
        section.closest<HTMLElement>('[class*="userProfileModal"]') ||
        section.closest<HTMLElement>('[class*="userProfileOuter"]') ||
        section.closest<HTMLElement>('[class*="profilePanel"]') ||
        section;

    for (const el of profileScope.querySelectorAll<HTMLElement>("span, div, h2, h3, label, p")) {
        if (el.closest("#vc-advanced-note-profile-host")) continue;
        const t = normalizeText(el.textContent);
        if (/^note \(only visible to you\)$/i.test(t) || /^click to add a note$/i.test(t))
            el.style.display = "none";
    }

    hideDefaultNoteUi(section, profileHost);

    if (!profileHost || !section.contains(profileHost)) {
        removeProfileNoteButton();
        profileHost = document.createElement("div");
        profileHost.id = "vc-advanced-note-profile-host";
        profileHost.className = "vc-advanced-note-profile-host";
        section.appendChild(profileHost);
        profileRoot = createRoot(profileHost);
    }

    const currentId = profileHost.getAttribute("data-user-id");
    if (currentId !== userId) {
        profileHost.setAttribute("data-user-id", userId);
        profileRoot?.render(<ProfileNotesButton userId={userId} isSideBar />);
    }
}

function queueProfileNoteButton() {
    placeNotes.run(() => {
        try { placeFullProfileNote(); } catch { /* ignore */ }
        try { placePopoutButton(); } catch { /* ignore */ }
    });
}

function queuePopoutButton() {
    queueProfileNoteButton();
}

export default definePlugin({
    name: "AdvancedNotes",
    description: "Replaces profile Note with Advanced Notes, including a quick button under View Full Profile",
    tags: ["Utility"],
    searchTerms: ["note", "notes", "markdown", "md", "profile", "delexo"],
    authors: [Delexo],
    requiresRestart: false,
    settings,
    managedStyle,

    patches: [
        {
            find: "Messages.NOTE_PLACEHOLDER",
            replacement: {
                match: /function (\i)\((\i)\)\{/,
                replace: "function $1($2){return $self.AdvancedNoteField($2);"
            }
        },
        {
            find: "#{intl::NOTE_PLACEHOLDER}",
            replacement: {
                match: /function (\i)\((\i)\)\{/,
                replace: "function $1($2){return $self.AdvancedNoteField($2);"
            }
        }
    ],

    AdvancedNoteField,
    ProfileNotesButton,

    start() {
        queuePopoutButton();
        queueProfileNoteButton();
        popoutObserver = new MutationObserver(records => {
            if (popoutHost || profileHost || mutationClassMatches(records, PROFILE_UI_RE))
                queueProfileNoteButton();
        });
        popoutObserver.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        placeNotes.cancel();
        popoutObserver?.disconnect();
        popoutObserver = null;
        removePopoutButton();
        removeProfileNoteButton();
    }
});
