/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { PluginNative } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { Button, Modal, openModal, Text, UserStore, useEffect, useRef, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.AdvancedNotes as PluginNative<typeof import("./native")> | undefined;
const NoteStore = findStoreLazy("NoteStore") as {
    getNote?: (userId: string) => { note?: string; } | string | null | undefined;
} | undefined;

export type NoteFieldProps = {
    userId: string;
    className?: string;
    autoFocus?: boolean;
    onUpdate?: () => void;
};

function discordNoteText(userId: string): string {
    try {
        const raw = NoteStore?.getNote?.(userId);
        if (typeof raw === "string") return raw;
        if (raw && typeof raw === "object" && typeof raw.note === "string") return raw.note;
    } catch { /* store missing on some builds */ }
    return "";
}

function stripMeta(raw: string) {
    const text = raw ?? "";
    if (text.startsWith("---\n")) {
        const end = text.indexOf("\n---\n", 4);
        if (end !== -1) return text.slice(end + 5);
    }
    return text.replace(/^<!--[\s\S]*?-->\s*/m, "");
}

function wrapMeta(userId: string, username: string | undefined, body: string) {
    const stamp = new Date().toISOString();
    const name = (username ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, " ");
    return `---\nuserId: "${userId}"\nusername: "${name}"\nupdatedAt: "${stamp}"\n---\n${body}`;
}

async function loadNoteText(userId: string): Promise<string> {
    if (!Native) return "";
    const user = UserStore.getUser(userId);
    const res = await Native.readNote(userId, user?.username);
    if (!res?.ok) return "";
    return stripMeta(res.data ?? "");
}

async function saveNoteText(userId: string, body: string) {
    if (!Native) throw new Error("Native helpers unavailable (desktop only)");
    const user = UserStore.getUser(userId);
    const username = user?.username || userId;
    const payload = wrapMeta(userId, username, body);
    const res = await Native.writeNote(userId, payload, username);
    if (!res?.ok) throw new Error(res?.data || "save failed");
    return res.data;
}

function noteFileName(username?: string | null, userId?: string) {
    const raw = String(username || userId || "unknown")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/[. ]+$/g, "")
        .trim();
    return `${raw || "unknown"}.md`;
}

function NoteEditorModal({
    userId,
    modalProps,
    initial,
    onSaved,
}: {
    userId: string;
    modalProps: RenderModalProps;
    initial: string;
    onSaved: (text: string) => void;
}) {
    const user = UserStore.getUser(userId);
    const username = user?.username || "user";
    const title = `Notes: ${username}`;
    const [text, setText] = useState(initial);
    const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [error, setError] = useState("");
    const [pathHint, setPathHint] = useState(noteFileName(username, userId));
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latest = useRef(text);
    const onSavedRef = useRef(onSaved);
    const skipFirst = useRef(true);
    latest.current = text;
    onSavedRef.current = onSaved;

    useEffect(() => {
        void Native?.getNotesDir().then(r => {
            if (r?.ok) setPathHint(`${r.data}\\${noteFileName(username, userId)}`);
            else setPathHint(noteFileName(username, userId));
        });
    }, [userId, username]);

    useEffect(() => {
        if (skipFirst.current) {
            skipFirst.current = false;
            return;
        }
        if (timer.current) clearTimeout(timer.current);
        setStatus("idle");
        timer.current = setTimeout(() => {
            void (async () => {
                try {
                    setStatus("saving");
                    const savedPath = await saveNoteText(userId, latest.current);
                    onSavedRef.current(latest.current);
                    if (savedPath) setPathHint(savedPath);
                    setStatus("saved");
                    setError("");
                } catch (e) {
                    setStatus("error");
                    setError(String(e));
                }
            })();
        }, 450);
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [text, userId]);

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
        void saveNoteText(userId, latest.current)
            .then(() => onSavedRef.current(latest.current))
            .catch(() => { /* ignore */ });
    }, [userId]);

    const statusLabel =
        status === "saving" ? "Saving…"
            : status === "saved" ? "Saved"
                : status === "error" ? "Save failed"
                    : "Autosave";

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={title}
            subtitle={`Saves to Documents\\AdvancedNotes\\${noteFileName(username, userId)}`}
            actions={[
                {
                    text: "Open folder",
                    variant: "secondary",
                    onClick: () => void Native?.openNotesFolder()
                },
                {
                    text: "Done",
                    variant: "primary",
                    onClick: modalProps.onClose
                }
            ]}
        >
            <div className="vc-advanced-note-modal-body">
                <textarea
                    className="vc-advanced-note-textarea"
                    value={text}
                    autoFocus
                    spellCheck
                    placeholder="Write anything. No character limit"
                    onChange={e => setText(e.currentTarget.value)}
                />
                <div className="vc-advanced-note-status">
                    <span className={status === "saved" ? "ok" : status === "error" ? "err" : undefined}>
                        {status === "error" && error ? error : statusLabel}
                    </span>
                    <span title={pathHint}>{noteFileName(username, userId)}</span>
                </div>
            </div>
        </Modal>
    );
}

export function openAdvancedNoteModal(userId: string, onSaved?: (text: string) => void) {
    void (async () => {
        let initial = await loadNoteText(userId);
        if (!initial.trim()) initial = discordNoteText(userId);
        openModal(props => (
            <ErrorBoundary>
                <NoteEditorModal
                    userId={userId}
                    modalProps={props}
                    initial={initial}
                    onSaved={text => onSaved?.(text)}
                />
            </ErrorBoundary>
        ));
    })();
}

export const AdvancedNoteField = ErrorBoundary.wrap(function AdvancedNoteField(props: NoteFieldProps) {
    const userId = props?.userId;
    const className = props?.className;
    const autoFocus = props?.autoFocus;
    if (!userId) return null;
    const [preview, setPreview] = useState("");
    const [loaded, setLoaded] = useState(false);
    const opened = useRef(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let alive = true;
        void loadNoteText(userId).then(text => {
            if (!alive) return;
            if (!text.trim()) text = discordNoteText(userId);
            setPreview(text);
            setLoaded(true);
        });
        return () => { alive = false; };
    }, [userId]);

    useEffect(() => {
        if (autoFocus && loaded && !opened.current) {
            opened.current = true;
            openAdvancedNoteModal(userId, setPreview);
        }
    }, [autoFocus, loaded, userId]);

    // Hide Discord's "Note (only visible to you)" label around our replacement
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const hideIfNoteLabel = (node: Element | null) => {
            if (!(node instanceof HTMLElement)) return;
            const t = (node.textContent || "").replace(/\s+/g, " ").trim();
            if (/^note\b/i.test(t) && /only visible to you/i.test(t))
                node.style.display = "none";
            else if (/^note$/i.test(t) && node.children.length === 0)
                node.style.display = "none";
        };
        const parent = root.parentElement;
        if (parent) {
            for (const child of Array.from(parent.children)) {
                if (child === root || root.contains(child)) continue;
                hideIfNoteLabel(child);
            }
            let sib = parent.previousElementSibling;
            for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling)
                hideIfNoteLabel(sib);
        }
    }, [loaded]);

    const hasNote = Boolean(preview.trim());

    return (
        <div ref={rootRef} className={classes("vc-advanced-note-wrap", className)}>
            <Button
                size={Button.Sizes.SMALL}
                color={Button.Colors.BRAND}
                className="vc-advanced-note-btn"
                onClick={() => openAdvancedNoteModal(userId, setPreview)}
            >
                Advanced Notes
            </Button>
            <Text variant="text-xs/normal" className="vc-advanced-note-btn-hint">
                {hasNote ? "Saved locally" : "Click to add a note"}
            </Text>
        </div>
    );
}, { noop: true });

export async function getNotesDirPath() {
    const res = await Native?.getNotesDir();
    return res?.ok ? res.data : "";
}

export async function listNotesCount() {
    const res = await Native?.listNoteFiles();
    if (!res?.ok || !res.data) return 0;
    try {
        const files = JSON.parse(res.data) as string[];
        return Array.isArray(files) ? files.length : 0;
    } catch {
        return 0;
    }
}

export async function openNotesFolder() {
    await Native?.openNotesFolder();
}
