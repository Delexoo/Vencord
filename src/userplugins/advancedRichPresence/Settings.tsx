/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { ExpandableSection } from "@components/ExpandableCard";
import { resolveError, SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { Switch } from "@components/Switch";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { ActivityType } from "@vencord/discord-types/enums";
import { Button, Select, showToast, Text, TextArea, TextInput, Toasts, useEffect, useState } from "@webpack/common";
import type { ReactNode } from "react";

import AdvancedRichPresence, { setRpc, settings, TimestampMode } from ".";
import type { PresencePreset } from "./markdown";
import {
    createNewPreset,
    deletePresetFile,
    getCachedPresets,
    loadPresetIntoStore,
    openPresetsFolder,
    refreshPresets,
    saveCurrentAsPreset,
} from "./store";

const cl = classNameFactory("vc-arp-");

type SettingsKey = keyof typeof settings.store;

const updateRPC = debounce(() => {
    try {
        setRpc(true);
        if (isPluginEnabled(AdvancedRichPresence.name)) void setRpc();
        const { activeFile, activeName } = settings.store;
        if (activeFile)
            void saveCurrentAsPreset(settings.store, activeName || "Untitled", activeFile);
    } catch (e) {
        console.error("[AdvancedRichPresence] updateRPC failed", e);
    }
});

function toast(message: string, type = Toasts.Type.SUCCESS) {
    try { showToast(message, type); } catch { /* ignore */ }
}

const makeValidator = (maxLength: number, isRequired = false) => (value: string) => {
    if (isRequired && !value) return "This field is required.";
    if (value.length > maxLength) return `Must be not longer than ${maxLength} characters.`;
    return true;
};

const maxLength128 = makeValidator(128);

function isAppIdValid(value: string) {
    if (value && !/^\d{16,21}$/.test(value)) return "Must be a valid Discord ID.";
    return true;
}

function isStreamLinkDisabled() {
    return settings.store.type !== ActivityType.STREAMING;
}

function isStreamLinkValid(value: string) {
    if (!isStreamLinkDisabled() && value && !/https?:\/\/(www\.)?(twitch\.tv|youtube\.com)\/\w+/.test(value))
        return "Streaming link must be a valid URL.";
    if (value && value.length > 512) return "Streaming link must be not longer than 512 characters.";
    return true;
}

function parseNumber(value: string) {
    return value ? parseInt(value, 10) : 0;
}

function isNumberValid(value: number) {
    if (isNaN(value)) return "Must be a number.";
    if (value < 0) return "Must be a positive number.";
    return true;
}

function isUrlValid(value: string) {
    if (value && !/^https?:\/\/.+/.test(value)) return "Must be a valid URL.";
    return true;
}

function isImageKeyValid(value: string) {
    if (/https?:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(value))
        return "Don't use a Discord link. Use an Imgur image link instead.";
    if (/https?:\/\/(?!i\.)?imgur\.com\//.test(value))
        return "Imgur link must be a direct link to the image (e.g. https://i.imgur.com/...). Right click the image and click 'Copy image address'";
    if (/https?:\/\/(?!media\.)?tenor\.com\//.test(value))
        return "Tenor link must be a direct link to the image (e.g. https://media.tenor.com/...). Right click the GIF and click 'Copy image address'";
    return true;
}

interface TextOption<T> {
    settingsKey: SettingsKey;
    label: string;
    disabled?: boolean;
    hint?: string;
    placeholder?: string;
    transform?: (value: string) => T;
    isValid?: (value: T) => true | string;
}

interface SelectOption<T> {
    settingsKey: SettingsKey;
    label: string;
    disabled?: boolean;
    hint?: string;
    options: { label: string; value: T; default?: boolean; }[];
}

function PairSetting<T>(props: { data: [TextOption<T>, TextOption<T>]; }) {
    const [left, right] = props.data;
    return (
        <div className={cl("pair")}>
            <SingleSetting {...left} />
            <SingleSetting {...right} />
        </div>
    );
}

function SingleSetting<T>({ settingsKey, label, disabled, isValid, transform, hint, placeholder }: TextOption<T>) {
    const s = settings.use(["activeFile"] as never);
    const [state, setState] = useState(settings.store[settingsKey] ?? "");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setState(settings.store[settingsKey] ?? "");
        setError(null);
    }, [s.activeFile, settingsKey]);

    function handleChange(newValue: any) {
        if (transform) newValue = transform(newValue);

        const valid = isValid?.(newValue) ?? true;

        setState(newValue);
        setError(resolveError(valid));

        if (valid === true) {
            (settings.store as Record<string, unknown>)[settingsKey] = newValue;
            updateRPC();
        }
    }

    return (
        <div className={cl({ disabled })}>
            <SettingsSection name={label} id={String(settingsKey)} description={hint ?? ""} error={error}>
                <TextInput
                    type="text"
                    placeholder={placeholder ?? "Enter a value"}
                    value={state as any}
                    onChange={handleChange}
                    disabled={disabled}
                />
            </SettingsSection>
        </div>
    );
}

function SelectSetting<T>({ settingsKey, label, options, disabled, hint }: SelectOption<T>) {
    settings.use(["activeFile", settingsKey] as never);
    const selected = settings.store[settingsKey] ?? options.find(o => o.default)?.value;

    return (
        <div className={cl({ disabled })}>
            <SettingsSection name={label} id={String(settingsKey)} description={hint ?? ""} error={null}>
                <Select
                    placeholder="Select an option"
                    options={options}
                    maxVisibleItems={5}
                    closeOnSelect={true}
                    select={v => {
                        (settings.store as Record<string, unknown>)[settingsKey] = v;
                        updateRPC();
                    }}
                    isSelected={v => v === selected}
                    serialize={v => String(v)}
                    isDisabled={disabled}
                />
            </SettingsSection>
        </div>
    );
}

function Fold({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean; }) {
    return (
        <ExpandableSection
            className={cl("fold")}
            initialExpanded={open}
            renderContent={() => <div className={cl("fold-body")}>{children}</div>}
        >
            <span className={cl("fold-title")}>{title}</span>
        </ExpandableSection>
    );
}

function NotesField() {
    const s = settings.use(["activeFile", "notes"] as never);
    const [state, setState] = useState(String(s.notes ?? ""));

    useEffect(() => {
        setState(String(settings.store.notes ?? ""));
    }, [s.activeFile, s.notes]);

    return (
        <SettingsSection name="Notes for yourself" id="notes" description="Reminders only you see. Never shown on Discord.">
            <TextArea
                value={state}
                placeholder="Optional notes"
                onChange={(v: string) => {
                    setState(v);
                    settings.store.notes = v;
                    updateRPC();
                }}
            />
        </SettingsSection>
    );
}

function PresetManager() {
    const s = settings.use(["activeFile", "activeName", "rpcEnabled"] as never);
    const [presets, setPresets] = useState<PresencePreset[]>(getCachedPresets());
    const [newName, setNewName] = useState("");
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

    const active = s.activeFile || "";
    const hasActive = Boolean(s.activeFile);
    const enabled = s.rpcEnabled !== false;

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
        <div className={cl("ml")}>
            <SettingsSection
                tag="label"
                name="Show on my profile"
                id="rpcEnabled"
                description="Whether friends see this custom status under your name."
                inlineSetting
            >
                <Switch
                    checked={enabled}
                    onChange={v => {
                        settings.store.rpcEnabled = v;
                        updateRPC();
                    }}
                />
            </SettingsSection>

            <SettingsSection
                name="Preset"
                id="preset"
                description="Select a saved status. Your edits apply to the one that’s selected."
            >
                <Select
                    placeholder={presets.length ? "Select a preset" : "No presets yet — create one below"}
                    options={presets.map(p => ({
                        label: p.fileName === active ? `${p.name} (selected)` : p.name,
                        value: p.fileName,
                    }))}
                    maxVisibleItems={8}
                    serialize={String}
                    isSelected={v => v === active}
                    select={async file => {
                        if (!file || file === active) return;
                        await run(async () => {
                            await loadPresetIntoStore(settings.store, file);
                            updateRPC();
                            toast(`Now using “${settings.store.activeName}”`);
                        });
                    }}
                    closeOnSelect
                    isDisabled={busy || presets.length === 0}
                />
            </SettingsSection>

            <SettingsSection
                name="New preset"
                id="newPreset"
                description="Type a name and click Create. Copies whatever you’ve filled in below."
            >
                <div className={cl("ml-row")}>
                    <TextInput
                        value={newName}
                        placeholder="Studying, Spotify, Gym…"
                        onChange={setNewName}
                    />
                    <Button
                        size={Button.Sizes.SMALL}
                        disabled={busy || !newName.trim()}
                        onClick={() => run(async () => {
                            const p = await createNewPreset(settings.store, newName);
                            toast(`Created “${p.name}”`);
                            setPresets(getCachedPresets());
                            setNewName("");
                            updateRPC();
                        })}
                    >
                        Create
                    </Button>
                </div>
            </SettingsSection>

            <SettingsSection
                name="Save or delete"
                id="presetActions"
                description="Save updates the selected preset. Delete removes it from this device."
            >
                <div className={cl("ml-row")}>
                    <Button
                        size={Button.Sizes.SMALL}
                        disabled={busy || !hasActive}
                        onClick={() => run(async () => {
                            if (!s.activeFile) return;
                            const p = await saveCurrentAsPreset(
                                settings.store,
                                s.activeName || "Untitled",
                                s.activeFile
                            );
                            toast(`Saved “${p.name}”`);
                            setPresets(getCachedPresets());
                            updateRPC();
                        })}
                    >
                        Save
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.RED}
                        disabled={busy || !hasActive}
                        onClick={() => run(async () => {
                            if (!s.activeFile) return;
                            const gone = s.activeName || "preset";
                            await deletePresetFile(settings.store, s.activeFile);
                            toast(`Deleted “${gone}”`);
                            setPresets(getCachedPresets());
                            updateRPC();
                        })}
                    >
                        Delete
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.PRIMARY}
                        disabled={busy}
                        onClick={() => run(async () => { await openPresetsFolder(); })}
                    >
                        Open folder
                    </Button>
                </div>
            </SettingsSection>
        </div>
    );
}

function RpcFields() {
    const s = settings.use(["type", "timestampMode"] as never);

    return (
        <div className={cl("ml")}>
            <SelectSetting
                settingsKey="type"
                label="Status type"
                hint="Playing, Streaming, Listening, Watching, or Competing."
                options={[
                    { label: "Playing", value: ActivityType.PLAYING, default: true },
                    { label: "Streaming", value: ActivityType.STREAMING },
                    { label: "Listening", value: ActivityType.LISTENING },
                    { label: "Watching", value: ActivityType.WATCHING },
                    { label: "Competing", value: ActivityType.COMPETING },
                ]}
            />

            <PairSetting data={[
                { settingsKey: "appName", label: "Title", isValid: makeValidator(128, true), placeholder: "My activity", hint: "The bold name people see, like a game or app." },
                { settingsKey: "appID", label: "App ID (optional)", isValid: isAppIdValid, placeholder: "From Developer Portal", hint: "Only needed if you upload images in the Discord Developer Portal." },
            ]} />

            <PairSetting data={[
                { settingsKey: "details", label: "Line 1", isValid: maxLength128, placeholder: "What you’re up to", hint: "First line under the title. You can use {user}, {time}, {date}." },
                { settingsKey: "detailsURL", label: "Line 1 link", isValid: isUrlValid, placeholder: "https://…" },
            ]} />

            <PairSetting data={[
                { settingsKey: "state", label: "Line 2", isValid: maxLength128, placeholder: "A bit more detail" },
                { settingsKey: "stateURL", label: "Line 2 link", isValid: isUrlValid, placeholder: "https://…" },
            ]} />

            {s.type === ActivityType.STREAMING && (
                <SingleSetting
                    settingsKey="streamLink"
                    label="Stream URL"
                    placeholder="https://twitch.tv/… or YouTube"
                    isValid={isStreamLinkValid}
                />
            )}

            <Fold title="Pictures">
                <Text variant="text-xs/normal" className={cl("hint")}>
                    Paste a direct image link (right-click → Copy image address), not a Discord CDN link.
                </Text>
                <PairSetting data={[
                    { settingsKey: "imageBig", label: "Large picture", isValid: isImageKeyValid, placeholder: "https://i.imgur.com/…" },
                    { settingsKey: "imageBigTooltip", label: "Large picture hover text", isValid: maxLength128 },
                ]} />
                <SingleSetting settingsKey="imageBigURL" label="Large picture click link" isValid={isUrlValid} placeholder="https://…" />
                <PairSetting data={[
                    { settingsKey: "imageSmall", label: "Small picture", isValid: isImageKeyValid, placeholder: "https://i.imgur.com/…" },
                    { settingsKey: "imageSmallTooltip", label: "Small picture hover text", isValid: maxLength128 },
                ]} />
                <SingleSetting settingsKey="imageSmallURL" label="Small picture click link" isValid={isUrlValid} placeholder="https://…" />
            </Fold>

            <Fold title="Buttons others can click">
                <Text variant="text-xs/normal" className={cl("hint")}>
                    You won’t see these on your own profile. Other people will.
                </Text>
                <PairSetting data={[
                    { settingsKey: "buttonOneText", label: "Button 1 label", isValid: makeValidator(31), placeholder: "Open site" },
                    { settingsKey: "buttonOneURL", label: "Button 1 link", isValid: isUrlValid, placeholder: "https://…" },
                ]} />
                <PairSetting data={[
                    { settingsKey: "buttonTwoText", label: "Button 2 label", isValid: makeValidator(31) },
                    { settingsKey: "buttonTwoURL", label: "Button 2 link", isValid: isUrlValid, placeholder: "https://…" },
                ]} />
            </Fold>

            <Fold title="More options">
                <PairSetting data={[
                    {
                        settingsKey: "partySize",
                        label: "Party size",
                        transform: parseNumber,
                        isValid: isNumberValid,
                        disabled: s.type !== ActivityType.PLAYING,
                    },
                    {
                        settingsKey: "partyMaxSize",
                        label: "Party max",
                        transform: parseNumber,
                        isValid: isNumberValid,
                        disabled: s.type !== ActivityType.PLAYING,
                    },
                ]} />
                <SingleSetting settingsKey="partyId" label="Party ID" hint="Optional. Leave blank unless you know you need it." />
                <SelectSetting
                    settingsKey="timestampMode"
                    label="Timer"
                    options={[
                        { label: "No timer", value: TimestampMode.NONE },
                        { label: "Elapsed since Discord opened", value: TimestampMode.NOW },
                        { label: "Elapsed since midnight", value: TimestampMode.TIME, default: true },
                        { label: "Custom timestamps", value: TimestampMode.CUSTOM },
                    ]}
                />
                <PairSetting data={[
                    {
                        settingsKey: "startTime",
                        label: "Start time (ms)",
                        transform: parseNumber,
                        isValid: isNumberValid,
                        disabled: s.timestampMode !== TimestampMode.CUSTOM,
                    },
                    {
                        settingsKey: "endTime",
                        label: "End time (ms)",
                        transform: parseNumber,
                        isValid: isNumberValid,
                        disabled: s.timestampMode !== TimestampMode.CUSTOM,
                    },
                ]} />
                <NotesField />
            </Fold>
        </div>
    );
}

export function PresenceSettings() {
    return (
        <div className={cl("root")}>
            <PresetManager />
            <RpcFields />
        </div>
    );
}
