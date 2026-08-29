/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { Button, Menu, Text, createRoot, useEffect, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

import { Delexo } from "../_delexo/author";
import { mutationClassMatches, scheduleOnce } from "../_delexo/idle";
import { AdvancedNoteField, getNotesDirPath, listNotesCount, openAdvancedNoteModal, openNotesFolder } from "./NoteModal";
import managedStyle from "./style.css?managed";

const DMSideBarClasses = findCssClassesLazy("widgetPreviews");

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

const userNotesMenuPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user?.id) return;
    children.push(
        <Menu.MenuItem
            id="vc-advanced-notes"
            label="Advanced Notes"
            action={() => openAdvancedNoteModal(user.id)}
        />
    );
};

function notesAlreadyMounted(scope?: ParentNode | null, ignoreHost?: Element | null) {
    const root = scope ?? document;
    for (const el of root.querySelectorAll?.(".vc-advanced-note-profile-actions, .vc-advanced-note-wrap, #vc-advanced-note-popout-host, #vc-advanced-note-profile-host") ?? []) {
        if (ignoreHost && (el === ignoreHost || ignoreHost.contains(el) || el.contains(ignoreHost))) continue;
        return true;
    }
    return false;
}

function normalizeText(s: string | null | undefined) {
    return (s ?? "").replace(/\s+/g, " ").trim();
}

function isNoteLabelText(t: string) {
    return /note \(only visible to you\)/i.test(t);
}

function isNotePlaceholderText(t: string) {
    return /click to add a note/i.test(t) || /^add a note$/i.test(t);
}

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

function isViewProfileControl(el: HTMLElement) {
    const t = normalizeText(el.textContent);
    const aria = normalizeText(el.getAttribute("aria-label"));
    const blob = `${t} ${aria}`;
    if (/view\s+(full\s+)?profile/i.test(blob)) return true;
    const href = String(el.getAttribute("href") ?? "");
    return /\/users\/\d+/.test(href) && /profile/i.test(blob);
}

function findViewFullProfileButton(): HTMLElement | null {
    const roots = document.querySelectorAll<HTMLElement>(
        '[class*="userPopoutOuter"], [class*="userPopoutInner"], [class*="userProfileOuter"], [class*="userProfileInner"], [class*="biteSize"], [class*="overlayTitle"], [class*="profileActions"]'
    );
    for (const root of roots) {
        for (const el of root.querySelectorAll<HTMLElement>("button, a, [role='button']")) {
            if (isViewProfileControl(el)) return el;
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

function findPopoutRoot(from: HTMLElement | null): HTMLElement | null {
    return from?.closest<HTMLElement>(
        '[class*="userPopoutOuter"], [class*="userPopoutInner"], [class*="userProfileOuter"], [class*="biteSize"]'
    ) ?? null;
}

function findPopoutMountTarget(): { row: HTMLElement; mount: HTMLElement; userId: string; } | null {
    const viewFull = findViewFullProfileButton();
    if (viewFull) {
        const userId = findUserIdNear(viewFull);
        const row = findProfileButtonRow(viewFull);
        const mount = row.parentElement;
        if (userId && mount) return { row, mount, userId };
    }

    const roots = document.querySelectorAll<HTMLElement>(
        '[class*="userPopoutOuter"], [class*="userPopoutInner"], [class*="biteSize"]'
    );
    for (const root of roots) {
        const overlay = root.querySelector<HTMLElement>(
            '[class*="overlayButtons"], [class*="buttonsContainer"], [class*="profileButtons"], [class*="actionButtons"]'
        );
        const row = overlay ?? root;
        const userId = findUserIdNear(row);
        if (!userId) continue;
        return { row, mount: row.parentElement ?? root, userId };
    }
    return null;
}

function placePopoutButton() {
    const target = findPopoutMountTarget();
    if (!target) {
        if (popoutHost && !document.body.contains(popoutHost)) removePopoutButton();
        return;
    }

    const { row, mount, userId } = target;
    const popout = findPopoutRoot(row) ?? mount;
    if (notesAlreadyMounted(popout, popoutHost)) {
        removePopoutButton();
        return;
    }

    if (popoutHost?.isConnected && popoutHost.previousElementSibling === row) {
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

    if (row.nextSibling)
        mount.insertBefore(popoutHost, row.nextSibling);
    else
        mount.appendChild(popoutHost);

    popoutRoot = createRoot(popoutHost);
    popoutRoot.render(<ProfileNotesButton userId={userId} />);
}

function findProfileRoot(): HTMLElement | null {
    return (
        document.querySelector<HTMLElement>('[class*="userProfileModal"]') ||
        document.querySelector<HTMLElement>('[class*="profilePanel"]')
    );
}

function findFullProfileNoteSection(): HTMLElement | null {
    const profileRoot = findProfileRoot();
    if (!profileRoot) return null;

    let labelEl: HTMLElement | null = null;
    let fieldEl: HTMLElement | null = null;

    for (const el of profileRoot.querySelectorAll<HTMLElement>(
        "span, div, h2, h3, label, p, button, [role='button']"
    )) {
        if (el.closest("#vc-advanced-note-popout-host, #vc-advanced-note-profile-host, .vc-advanced-note-profile-actions")) continue;
        if (el.children.length > 5) continue;

        const t = normalizeText(el.textContent);
        if (!labelEl && isNoteLabelText(t)) labelEl = el;
        if (!fieldEl && isNotePlaceholderText(t)) fieldEl = el;
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
        if (/note/i.test(text) && (isNotePlaceholderText(text) || /only visible to you/i.test(text)))
            return parent;
        section = parent;
    }

    return labelEl?.parentElement ?? fieldEl?.parentElement ?? null;
}

function findFullProfileMount(): HTMLElement | null {
    const section = findFullProfileNoteSection();
    if (section) return section;

    const profileRoot = findProfileRoot();
    if (!profileRoot) return null;

    return (
        profileRoot.querySelector<HTMLElement>('[class*="widgetPreviews"]')?.parentElement
        ?? profileRoot.querySelector<HTMLElement>('[class*="overlayButtons"], [class*="profileButtons"], [class*="actionButtons"]')?.parentElement
        ?? profileRoot
    );
}

function hideDefaultNoteUi(section: HTMLElement, keepHost: HTMLElement | null) {
    const hide = (el: Element | null) => {
        if (!(el instanceof HTMLElement)) return;
        if (keepHost && (el === keepHost || keepHost.contains(el) || el.contains(keepHost))) return;

        const t = normalizeText(el.textContent);
        const isNoteInput = el.matches("textarea, [contenteditable='true'], input");

        if (isNoteLabelText(t) || isNotePlaceholderText(t) || isNoteInput) {
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
    const mount = findFullProfileMount();
    if (!mount) {
        if (profileHost && !document.body.contains(profileHost)) removeProfileNoteButton();
        return;
    }

    const userId = findUserIdNear(mount);
    if (!userId) return;

    const profileScope =
        mount.closest<HTMLElement>('[class*="userProfileModal"]') ||
        mount.closest<HTMLElement>('[class*="userProfileOuter"]') ||
        mount.closest<HTMLElement>('[class*="profilePanel"]') ||
        mount;

    if (notesAlreadyMounted(profileScope, profileHost)) {
        removeProfileNoteButton();
        return;
    }

    const noteSection = findFullProfileNoteSection();
    if (noteSection) {
        for (const el of profileScope.querySelectorAll<HTMLElement>("span, div, h2, h3, label, p")) {
            if (el.closest("#vc-advanced-note-profile-host, .vc-advanced-note-profile-actions")) continue;
            const t = normalizeText(el.textContent);
            if (isNoteLabelText(t) || isNotePlaceholderText(t))
                el.style.display = "none";
        }
        hideDefaultNoteUi(noteSection, profileHost);
    }

    const hostParent = noteSection ?? mount;
    if (!profileHost || !hostParent.contains(profileHost)) {
        removeProfileNoteButton();
        profileHost = document.createElement("div");
        profileHost.id = "vc-advanced-note-profile-host";
        profileHost.className = "vc-advanced-note-profile-host";
        hostParent.appendChild(profileHost);
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
    description: "Adds an Advanced Notes button on user profiles and the right-click user menu",
    tags: ["Utility"],
    searchTerms: ["note", "notes", "markdown", "md", "profile", "delexo"],
    authors: [Delexo],
    requiresRestart: false,
    settings,
    managedStyle,

    contextMenus: {
        "user-context": userNotesMenuPatch,
        "user-profile-actions": userNotesMenuPatch,
        "user-profile-overflow-menu": userNotesMenuPatch
    },

    patches: [
        {
            find: ".SIDEBAR,disableToolbar:",
            replacement: {
                match: /user:(\i),widgets:.{0,100}?\}\),(?=.{0,100}unownedWishlistItems:\i,wishlistId:\i)/,
                replace: "$&$self.renderNotesButton({user:$1,isSideBar:true}),"
            }
        },
        {
            find: '"UserProfilePopout");',
            replacement: {
                match: /user:(\i),widgets:.{0,100}?\}\),/,
                replace: "$&$self.renderNotesButton({user:$1}),"
            }
        },
        {
            find: "Messages.NOTE_PLACEHOLDER",
            noWarn: true,
            replacement: {
                match: /function (\i)\((\i)\)\{/,
                replace: "function $1($2){return $self.AdvancedNoteField($2);"
            }
        },
        {
            find: "#{intl::NOTE_PLACEHOLDER}",
            noWarn: true,
            replacement: {
                match: /function (\i)\((\i)\)\{/,
                replace: "function $1($2){return $self.AdvancedNoteField($2);"
            }
        }
    ],

    flux: {
        USER_PROFILE_MODAL_OPEN() {
            queueProfileNoteButton();
        }
    },

    AdvancedNoteField,
    ProfileNotesButton,

    renderNotesButton: ErrorBoundary.wrap(({ user, isSideBar }: { user?: User; isSideBar?: boolean; }) => {
        if (!user?.id) return null;
        const button = <ProfileNotesButton user={user} isSideBar={isSideBar} />;
        return isSideBar
            ? <div className={DMSideBarClasses.widgetPreviews}>{button}</div>
            : button;
    }, { noop: true }),

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
