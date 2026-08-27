/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { ExpandableSection } from "@components/ExpandableCard";
import { Heading } from "@components/Heading";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { ActivityType } from "@vencord/discord-types/enums";
import { Button, Select, showToast, Switch, Text, TextArea, TextInput, Toasts, useEffect, useState } from "@webpack/common";

import AdvancedRichPresence, { setRpc, settings, TimestampMode } from ".";
import type { PresencePreset } from "./markdown";
import {
    createNewPreset,
    deletePresetFile,
    duplicatePreset,
    getCachedPresets,
    loadPresetIntoStore,
    openPresetsFolder,
    refreshPresets,
    renamePreset,
    saveCurrentAsPreset,
} from "./store";

const cl = classNameFactory("vc-arp-");

const ACTIVITY_LABEL: Record<number, string> = {
    [ActivityType.PLAYING]: "Playing",
    [ActivityType.STREAMING]: "Streaming",
    [ActivityType.LISTENING]: "Listening to",
    [ActivityType.WATCHING]: "Watching",
    [ActivityType.COMPETING]: "Competing in",
};

const updateRPC = debounce(() => {
    try {
        setRpc(true);
        if (isPluginEnabled(AdvancedRichPresence.name)) void setRpc();
    } catch (e) {
        console.error("[AdvancedRichPresence] updateRPC failed", e);
    }
});

function toast(message: string, type = Toasts.Type.SUCCESS) {
    try { showToast(message, type); } catch { /* ignore */ }
}

function Field({
    label,
    hint,
    settingsKey,
    multiline = false,
    placeholder,
}: {
    label: string;
    hint?: string;
    settingsKey: keyof typeof settings.store;
    multiline?: boolean;
    placeholder?: string;
}) {
    const s = settings.use([settingsKey as any, "activeFile"] as any);
    const [state, setState] = useState(String(s[settingsKey] ?? ""));

    useEffect(() => {
        setState(String(settings.store[settingsKey] ?? ""));
    }, [settings.store.activeFile, settings.store[settingsKey]]);

    const Comp = multiline ? TextArea : TextInput;
    return (
        <div className={cl("field")}>
            <Text variant="text-sm/semibold" className={cl("label")}>{label}</Text>
            <Comp
                value={state}
                placeholder={placeholder ?? label}
                onChange={(v: string) => {
                    setState(v);
                    (settings.store as any)[settingsKey] = v;
                    updateRPC();
                }}
            />
            {hint ? <Text variant="text-xs/normal" className={cl("hint")}>{hint}</Text> : null}
        </div>
    );
}

function LivePreview() {
    const s = settings.use([
        "rpcEnabled", "appName", "details", "state", "type", "activeName"
    ] as any);

    if (s.rpcEnabled === false) {
        return (
            <div className={cl("preview", "preview-off")}>
                <Text variant="text-sm/semibold">Preview</Text>
                <Text variant="text-sm/normal" className={cl("hint")}>Rich presence is off.</Text>
            </div>
        );
    }

    const typeLabel = ACTIVITY_LABEL[s.type ?? ActivityType.PLAYING] ?? "Playing";
    const title = (s.appName || "Untitled activity").trim();
    const line1 = (s.details || "").trim();
    const line2 = (s.state || "").trim();

    return (
        <div className={cl("preview")}>
            <div className={cl("preview-top")}>
                <Text variant="text-sm/semibold">How it looks</Text>
                {s.activeName ? (
                    <span className={cl("badge")}>Preset: {s.activeName}</span>
                ) : (
                    <span className={cl("badge", "badge-muted")}>Unsaved edits</span>
                )}
            </div>
            <div className={cl("preview-card")}>
                <div className={cl("preview-type")}>{typeLabel}</div>
                <div className={cl("preview-title")}>{title}</div>
                {line1 ? <div className={cl("preview-line")}>{line1}</div> : null}
                {line2 ? <div className={cl("preview-line", "muted")}>{line2}</div> : null}
            </div>
        </div>
    );
}

function PresetManager() {
    const s = settings.use(["activeFile", "activeName"] as any);
    const [presets, setPresets] = useState<PresencePreset[]>(getCachedPresets());
    const [nameDraft, setNameDraft] = useState(s.activeName || "");
    const [newName, setNewName] = useState("New preset");
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState(false);

    async function reloadList() {
        setBusy(true);
        try {
            setPresets(await refreshPresets());
        } catch (e) {
            toast(String(e), Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        void reloadList();
    }, []);

    useEffect(() => {
        setNameDraft(s.activeName || "");
    }, [s.activeFile, s.activeName]);

    const active = s.activeFile || "";
    const hasActive = Boolean(s.activeFile);
    const showCreate = creating || presets.length === 0;

    async function run(fn: () => Promise<void>) {
        if (busy) return;
        setBusy(true);
        try {
            await fn();
        } catch (e) {
            toast(String(e), Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={cl("section")}>
            <Heading tag="h3" className={cl("section-title")}>Presets</Heading>
            <Text variant="text-sm/normal" className={cl("hint")}>
                Each preset is one saved status. Select one to use it, create a new one, then edit the text below.
            </Text>

            <div className={cl("field")}>
                <Text variant="text-sm/semibold" className={cl("label")}>Select a preset</Text>
                <div className={cl("control")}>
                    <Select
                        placeholder="Choose a saved status"
                        options={presets.map(p => ({
                            label: p.fileName === active ? `${p.name}  ·  in use` : p.name,
                            value: p.fileName,
                        }))}
                        serialize={String}
                        isSelected={v => v === active}
                        select={async file => {
                            if (!file || file === active) return;
                            await run(async () => {
                                await loadPresetIntoStore(settings.store, file);
                                updateRPC();
                                toast(`Now using “${settings.store.activeName}”`);
                                setNameDraft(settings.store.activeName || "");
                            });
                        }}
                        closeOnSelect
                    />
                </div>
                <Text variant="text-xs/normal" className={cl("status")}>
                    {hasActive
                        ? `Using “${s.activeName}”. Change the fields below, then click Save.`
                        : "Nothing selected yet. Pick a preset above, or create a new one."}
                </Text>
            </div>

            {showCreate ? (
                <div className={cl("create")}>
                    <Text variant="text-sm/semibold" className={cl("label")}>
                        {presets.length === 0 ? "Create your first preset" : "Name the new preset"}
                    </Text>
                    <div className={cl("create-row")}>
                        <TextInput
                            value={newName}
                            placeholder="e.g. Studying, In class, Streaming"
                            onChange={setNewName}
                        />
                        <Button
                            className={cl("btn")}
                            disabled={busy || !newName.trim()}
                            onClick={() => run(async () => {
                                const p = await createNewPreset(settings.store, newName);
                                toast(`Created “${p.name}”`);
                                setPresets(getCachedPresets());
                                setNameDraft(p.name);
                                setNewName("New preset");
                                setCreating(false);
                                updateRPC();
                            })}
                        >
                            Create
                        </Button>
                        {presets.length > 0 && (
                            <Button
                                className={cl("btn")}
                                color={Button.Colors.PRIMARY}
                                disabled={busy}
                                onClick={() => {
                                    setCreating(false);
                                    setNewName("New preset");
                                }}
                            >
                                Cancel
                            </Button>
                        )}
                    </div>
                    <Text variant="text-xs/normal" className={cl("hint")}>
                        Starts blank. Fill in the activity text below after you create it.
                    </Text>
                </div>
            ) : (
                <div className={cl("btn-grid")}>
                    <Button
                        className={cl("btn")}
                        disabled={busy}
                        onClick={() => {
                            setNewName("New preset");
                            setCreating(true);
                        }}
                    >
                        New preset
                    </Button>
                    <Button
                        className={cl("btn")}
                        color={Button.Colors.PRIMARY}
                        disabled={busy || !hasActive}
                        onClick={() => run(async () => {
                            if (!s.activeFile) return;
                            const p = await saveCurrentAsPreset(
                                settings.store,
                                nameDraft.trim() || s.activeName || "Untitled",
                                s.activeFile
                            );
                            toast(`Saved “${p.name}”`);
                            setPresets(getCachedPresets());
                            setNameDraft(p.name);
                            updateRPC();
                        })}
                    >
                        Save
                    </Button>
                    <Button
                        className={cl("btn")}
                        color={Button.Colors.PRIMARY}
                        disabled={busy || !hasActive}
                        onClick={() => run(async () => {
                            if (!s.activeFile) return;
                            const p = await duplicatePreset(settings.store, s.activeFile);
                            toast(`Duplicated as “${p.name}”`);
                            setPresets(getCachedPresets());
                            setNameDraft(p.name);
                            updateRPC();
                        })}
                    >
                        Duplicate
                    </Button>
                    <Button
                        className={cl("btn")}
                        color={Button.Colors.RED}
                        disabled={busy || !hasActive}
                        onClick={() => run(async () => {
                            if (!s.activeFile) return;
                            const gone = s.activeName || "preset";
                            await deletePresetFile(settings.store, s.activeFile);
                            toast(`Deleted “${gone}”`);
                            const next = getCachedPresets();
                            setPresets(next);
                            setNameDraft(settings.store.activeName || "");
                            updateRPC();
                        })}
                    >
                        Delete
                    </Button>
                </div>
            )}

            {hasActive && !showCreate && (
                <div className={cl("rename")}>
                    <div className={cl("field")}>
                        <Text variant="text-sm/semibold" className={cl("label")}>Rename this preset</Text>
                        <TextInput
                            value={nameDraft}
                            placeholder="Preset name"
                            onChange={setNameDraft}
                        />
                    </div>
                    <Button
                        className={cl("btn")}
                        color={Button.Colors.PRIMARY}
                        disabled={busy || !nameDraft.trim() || nameDraft.trim() === s.activeName}
                        onClick={() => run(async () => {
                            if (!s.activeFile) return;
                            const p = await renamePreset(settings.store, s.activeFile, nameDraft);
                            toast(`Renamed to “${p.name}”`);
                            setPresets(getCachedPresets());
                            setNameDraft(p.name);
                            updateRPC();
                        })}
                    >
                        Rename
                    </Button>
                </div>
            )}

            <div className={cl("link-row")}>
                <Button
                    className={cl("link")}
                    size={Button.Sizes.SMALL}
                    look={Button.Looks.LINK}
                    onClick={() => run(async () => { await openPresetsFolder(); })}
                >
                    Open presets folder
                </Button>
                <Button
                    className={cl("link")}
                    size={Button.Sizes.SMALL}
                    look={Button.Looks.LINK}
                    disabled={busy}
                    onClick={() => void reloadList()}
                >
                    Refresh list
                </Button>
            </div>
        </div>
    );
}

function Basics() {
    const s = settings.use(["type", "timestampMode"] as any);

    return (
        <div className={cl("section")}>
            <Heading tag="h3" className={cl("section-title")}>What people see</Heading>
            <Text variant="text-sm/normal" className={cl("hint")}>
                Edits apply live while rich presence is on. You can use {"{time}"}, {"{date}"}, or {"{preset}"} in text lines.
            </Text>

            <Field
                label="Application ID"
                hint="From the Discord Developer Portal app that owns your images (optional if you only use image URLs)."
                settingsKey="appID"
                placeholder="e.g. 1260139887504392200"
            />
            <Field
                label="Activity name"
                hint="The big title under Playing / Listening / etc."
                settingsKey="appName"
                placeholder="e.g. Harvard Online"
            />

            <div className={cl("field")}>
                <Text variant="text-sm/semibold" className={cl("label")}>Activity type</Text>
                <div className={cl("control")}>
                    <Select
                        options={[
                            { label: "Playing", value: ActivityType.PLAYING, default: true },
                            { label: "Streaming", value: ActivityType.STREAMING },
                            { label: "Listening", value: ActivityType.LISTENING },
                            { label: "Watching", value: ActivityType.WATCHING },
                            { label: "Competing", value: ActivityType.COMPETING },
                        ]}
                        serialize={String}
                        isSelected={v => v === (s.type ?? ActivityType.PLAYING)}
                        select={v => {
                            settings.store.type = v;
                            updateRPC();
                        }}
                        closeOnSelect
                    />
                </div>
            </div>

            {s.type === ActivityType.STREAMING && (
                <Field
                    label="Stream link"
                    hint="Twitch or YouTube URL (required for Streaming)."
                    settingsKey="streamLink"
                    placeholder="https://twitch.tv/..."
                />
            )}

            <Field
                label="Details (first line)"
                hint="Main subtitle under the activity name."
                settingsKey="details"
                placeholder="e.g. Studying biology"
            />
            <Field
                label="State (second line)"
                hint="Optional extra line under details."
                settingsKey="state"
                placeholder="e.g. Chapter 4"
            />

            <div className={cl("field")}>
                <Text variant="text-sm/semibold" className={cl("label")}>Elapsed / remaining time</Text>
                <div className={cl("control")}>
                    <Select
                        options={[
                            { label: "Hide timestamp", value: TimestampMode.NONE },
                            { label: "Counting up from now", value: TimestampMode.NOW },
                            { label: "Since start of today", value: TimestampMode.TIME, default: true },
                            { label: "Custom unix times", value: TimestampMode.CUSTOM },
                        ]}
                        serialize={String}
                        isSelected={v => v === (s.timestampMode ?? TimestampMode.TIME)}
                        select={v => {
                            settings.store.timestampMode = v;
                            updateRPC();
                        }}
                        closeOnSelect
                    />
                </div>
            </div>

            {(s.timestampMode ?? TimestampMode.TIME) === TimestampMode.CUSTOM && (
                <>
                    <Field label="Start time (unix ms)" settingsKey="startTime" />
                    <Field label="End time (unix ms)" settingsKey="endTime" />
                </>
            )}
        </div>
    );
}

export function PresenceSettings() {
    const s = settings.use(["rpcEnabled"] as any);

    return (
        <div className={cl("root")}>
            <div className={cl("section")}>
                <Heading tag="h3" className={cl("section-title")}>Status</Heading>
                <div className={cl("switch-row")}>
                    <Switch
                        value={s.rpcEnabled !== false}
                        onChange={v => {
                            settings.store.rpcEnabled = v;
                            updateRPC();
                        }}
                        hideBorder
                        className={cl("switch")}
                        note="When this is on, the selected preset shows on your Discord profile."
                    >
                        Show this status on my profile
                    </Switch>
                </div>
                <LivePreview />
            </div>

            <PresetManager />
            <Basics />

            <div className={cl("section")}>
                <Heading tag="h3" className={cl("section-title")}>Optional extras</Heading>
                <Text variant="text-sm/normal" className={cl("hint")}>
                    Images, buttons, and party size. Open a section only if you need it.
                </Text>

                <ExpandableSection
                    className={cl("fold")}
                    renderContent={() => (
                        <div className={cl("fold-body")}>
                            <Field label="Details click URL" settingsKey="detailsURL" placeholder="https://..." />
                            <Field label="State click URL" settingsKey="stateURL" placeholder="https://..." />
                            <Field
                                label="Large image"
                                hint="Asset key from your Discord app, or a direct image URL."
                                settingsKey="imageBig"
                            />
                            <Field label="Large image tooltip" settingsKey="imageBigTooltip" />
                            <Field label="Large image click URL" settingsKey="imageBigURL" />
                            <Field label="Small image" settingsKey="imageSmall" />
                            <Field label="Small image tooltip" settingsKey="imageSmallTooltip" />
                            <Field label="Small image click URL" settingsKey="imageSmallURL" />
                        </div>
                    )}
                >
                    <Text variant="text-sm/semibold">Images & click links</Text>
                </ExpandableSection>

                <ExpandableSection
                    className={cl("fold")}
                    renderContent={() => (
                        <div className={cl("fold-body")}>
                            <Field label="Button 1 text" settingsKey="buttonOneText" placeholder="Open site" />
                            <Field label="Button 1 URL" settingsKey="buttonOneURL" placeholder="https://..." />
                            <Field label="Button 2 text" settingsKey="buttonTwoText" />
                            <Field label="Button 2 URL" settingsKey="buttonTwoURL" />
                        </div>
                    )}
                >
                    <Text variant="text-sm/semibold">Buttons (up to 2)</Text>
                </ExpandableSection>

                <ExpandableSection
                    className={cl("fold")}
                    renderContent={() => (
                        <div className={cl("fold-body")}>
                            <Field label="Party ID" settingsKey="partyId" />
                            <Field label="Current party size" settingsKey="partySize" placeholder="1" />
                            <Field label="Max party size" settingsKey="partyMaxSize" placeholder="5" />
                        </div>
                    )}
                >
                    <Text variant="text-sm/semibold">Party size</Text>
                </ExpandableSection>

                <ExpandableSection
                    className={cl("fold")}
                    renderContent={() => (
                        <div className={cl("fold-body")}>
                            <Field
                                label="Private notes"
                                hint="Only saved in your .md preset file. Never shown on Discord."
                                settingsKey="notes"
                                multiline
                                placeholder="Reminders for yourself…"
                            />
                        </div>
                    )}
                >
                    <Text variant="text-sm/semibold">Private notes</Text>
                </ExpandableSection>
            </div>
        </div>
    );
}
