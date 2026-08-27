/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { ExpandableSection } from "@components/ExpandableCard";
import { Heading } from "@components/Heading";
import { resolveError } from "@components/settings/tabs/plugins/components/Common";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { ActivityType } from "@vencord/discord-types/enums";
import { Button, Select, showToast, Switch, Text, TextArea, TextInput, Toasts, useEffect, useState } from "@webpack/common";
import type { ReactNode } from "react";

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
        <div className={cl("single", { disabled })}>
            <Heading tag="h5">{label}</Heading>
            <TextInput
                type="text"
                placeholder={placeholder ?? "Enter a value"}
                value={state as any}
                onChange={handleChange}
                disabled={disabled}
            />
            {error && <Text className={cl("error")} variant="text-sm/normal">{error}</Text>}
            {hint ? <Text variant="text-xs/normal" className={cl("hint")}>{hint}</Text> : null}
        </div>
    );
}

function SelectSetting<T>({ settingsKey, label, options, disabled }: SelectOption<T>) {
    settings.use(["activeFile", settingsKey] as never);
    const selected = settings.store[settingsKey] ?? options.find(o => o.default)?.value;

    return (
        <div className={cl("single", { disabled })}>
            <Heading tag="h5">{label}</Heading>
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
        <div className={cl("single")}>
            <Heading tag="h5">Private notes</Heading>
            <TextArea
                value={state}
                placeholder="Reminders for yourself. Saved in the .md file, never shown on Discord."
                onChange={(v: string) => {
                    setState(v);
                    settings.store.notes = v;
                    updateRPC();
                }}
            />
        </div>
    );
}

function PresetManager() {
    const s = settings.use(["activeFile", "activeName", "rpcEnabled"] as never);
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

    const enabled = s.rpcEnabled !== false;

    return (
        <div className={cl("section")}>
            <div className={cl("section-head")}>
                <Heading tag="h3" className={cl("section-title")}>Presets</Heading>
                {hasActive && (
                    <Text variant="text-xs/normal" className={cl("status")}>
                        {s.activeName}
                    </Text>
                )}
            </div>

            <div className={cl("switch-row")}>
                <Switch
                    value={enabled}
                    onChange={v => {
                        settings.store.rpcEnabled = v;
                        updateRPC();
                    }}
                    hideBorder
                    className={cl("switch")}
                >
                    Show on my profile
                </Switch>
            </div>

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

            {showCreate ? (
                <div className={cl("create")}>
                    <div className={cl("create-row")}>
                        <TextInput
                            value={newName}
                            placeholder="Preset name"
                            onChange={setNewName}
                        />
                        <Button
                            className={cl("btn")}
                            size={Button.Sizes.SMALL}
                            disabled={busy || !newName.trim()}
                            onClick={() => run(async () => {
                                const p = await createNewPreset(settings.store, newName);
                                toast(`Created “${p.name}.md”`);
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
                                size={Button.Sizes.SMALL}
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
                </div>
            ) : (
                <div className={cl("btn-row")}>
                    <Button
                        className={cl("btn")}
                        size={Button.Sizes.SMALL}
                        disabled={busy}
                        onClick={() => {
                            setNewName("New preset");
                            setCreating(true);
                        }}
                    >
                        New
                    </Button>
                    <Button
                        className={cl("btn")}
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.PRIMARY}
                        disabled={busy || !hasActive}
                        onClick={() => run(async () => {
                            if (!s.activeFile) return;
                            const p = await saveCurrentAsPreset(
                                settings.store,
                                nameDraft.trim() || s.activeName || "Untitled",
                                s.activeFile
                            );
                            toast(`Saved “${p.name}.md”`);
                            setPresets(getCachedPresets());
                            setNameDraft(p.name);
                            updateRPC();
                        })}
                    >
                        Save
                    </Button>
                    <Button
                        className={cl("btn")}
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.PRIMARY}
                        disabled={busy || !hasActive}
                        onClick={() => run(async () => {
                            if (!s.activeFile) return;
                            const p = await duplicatePreset(settings.store, s.activeFile);
                            toast(`Duplicated as “${p.name}.md”`);
                            setPresets(getCachedPresets());
                            setNameDraft(p.name);
                            updateRPC();
                        })}
                    >
                        Duplicate
                    </Button>
                    <Button
                        className={cl("btn")}
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.RED}
                        disabled={busy || !hasActive}
                        onClick={() => run(async () => {
                            if (!s.activeFile) return;
                            const gone = s.activeName || "preset";
                            await deletePresetFile(settings.store, s.activeFile);
                            toast(`Deleted “${gone}.md”`);
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
                <Fold title="Rename">
                    <div className={cl("rename")}>
                        <TextInput
                            value={nameDraft}
                            placeholder="Preset name"
                            onChange={setNameDraft}
                        />
                        <Button
                            className={cl("btn")}
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.PRIMARY}
                            disabled={busy || !nameDraft.trim() || nameDraft.trim() === s.activeName}
                            onClick={() => run(async () => {
                                if (!s.activeFile) return;
                                const p = await renamePreset(settings.store, s.activeFile, nameDraft);
                                toast(`Renamed to “${p.name}.md”`);
                                setPresets(getCachedPresets());
                                setNameDraft(p.name);
                                updateRPC();
                            })}
                        >
                            Rename
                        </Button>
                    </div>
                </Fold>
            )}

            <div className={cl("link-row")}>
                <Button
                    className={cl("link")}
                    size={Button.Sizes.SMALL}
                    look={Button.Looks.LINK}
                    onClick={() => run(async () => { await openPresetsFolder(); })}
                >
                    Folder
                </Button>
                <Button
                    className={cl("link")}
                    size={Button.Sizes.SMALL}
                    look={Button.Looks.LINK}
                    disabled={busy}
                    onClick={() => void reloadList()}
                >
                    Refresh
                </Button>
            </div>
        </div>
    );
}

function RpcFields() {
    const s = settings.use(["type", "timestampMode"] as never);

    return (
        <div className={cl("section")}>
            <Heading tag="h3" className={cl("section-title")}>Activity</Heading>

            <SelectSetting
                settingsKey="type"
                label="Activity Type"
                options={[
                    { label: "Playing", value: ActivityType.PLAYING, default: true },
                    { label: "Streaming", value: ActivityType.STREAMING },
                    { label: "Listening", value: ActivityType.LISTENING },
                    { label: "Watching", value: ActivityType.WATCHING },
                    { label: "Competing", value: ActivityType.COMPETING },
                ]}
            />

            <PairSetting data={[
                { settingsKey: "appID", label: "Application ID", isValid: isAppIdValid, placeholder: "1260139887504392200" },
                { settingsKey: "appName", label: "Application Name", isValid: makeValidator(128, true), placeholder: "Harvard Online" },
            ]} />

            <PairSetting data={[
                { settingsKey: "details", label: "Detail (line 1)", isValid: maxLength128 },
                { settingsKey: "detailsURL", label: "Detail URL", isValid: isUrlValid },
            ]} />

            <PairSetting data={[
                { settingsKey: "state", label: "State (line 2)", isValid: maxLength128 },
                { settingsKey: "stateURL", label: "State URL", isValid: isUrlValid },
            ]} />

            {s.type === ActivityType.STREAMING && (
                <SingleSetting
                    settingsKey="streamLink"
                    label="Stream Link (Twitch or YouTube)"
                    isValid={isStreamLinkValid}
                />
            )}

            <Fold title="Images">
                <PairSetting data={[
                    { settingsKey: "imageBig", label: "Large Image URL/Key", isValid: isImageKeyValid },
                    { settingsKey: "imageBigTooltip", label: "Large Image Text", isValid: maxLength128 },
                ]} />
                <SingleSetting settingsKey="imageBigURL" label="Large Image clickable URL" isValid={isUrlValid} />
                <PairSetting data={[
                    { settingsKey: "imageSmall", label: "Small Image URL/Key", isValid: isImageKeyValid },
                    { settingsKey: "imageSmallTooltip", label: "Small Image Text", isValid: maxLength128 },
                ]} />
                <SingleSetting settingsKey="imageSmallURL" label="Small Image clickable URL" isValid={isUrlValid} />
            </Fold>

            <Fold title="Buttons">
                <PairSetting data={[
                    { settingsKey: "buttonOneText", label: "Button 1 Text", isValid: makeValidator(31) },
                    { settingsKey: "buttonOneURL", label: "Button 1 URL", isValid: isUrlValid },
                ]} />
                <PairSetting data={[
                    { settingsKey: "buttonTwoText", label: "Button 2 Text", isValid: makeValidator(31) },
                    { settingsKey: "buttonTwoURL", label: "Button 2 URL", isValid: isUrlValid },
                ]} />
            </Fold>

            <Fold title="Advanced">
                <PairSetting data={[
                    {
                        settingsKey: "partySize",
                        label: "Party Size",
                        transform: parseNumber,
                        isValid: isNumberValid,
                        disabled: s.type !== ActivityType.PLAYING,
                    },
                    {
                        settingsKey: "partyMaxSize",
                        label: "Maximum Party Size",
                        transform: parseNumber,
                        isValid: isNumberValid,
                        disabled: s.type !== ActivityType.PLAYING,
                    },
                ]} />
                <SingleSetting settingsKey="partyId" label="Party ID" />
                <SelectSetting
                    settingsKey="timestampMode"
                    label="Timestamp Mode"
                    options={[
                        { label: "None", value: TimestampMode.NONE },
                        { label: "Since Discord open", value: TimestampMode.NOW },
                        { label: "Same as your current time", value: TimestampMode.TIME, default: true },
                        { label: "Custom", value: TimestampMode.CUSTOM },
                    ]}
                />
                <PairSetting data={[
                    {
                        settingsKey: "startTime",
                        label: "Start Timestamp (ms)",
                        transform: parseNumber,
                        isValid: isNumberValid,
                        disabled: s.timestampMode !== TimestampMode.CUSTOM,
                    },
                    {
                        settingsKey: "endTime",
                        label: "End Timestamp (ms)",
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
