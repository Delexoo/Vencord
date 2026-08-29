/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { resolveError, SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { Switch } from "@components/Switch";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { ActivityType } from "@vencord/discord-types/enums";
import { Button, Select, showToast, Text, TextArea, TextInput, Toasts, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import AdvancedRichPresence, { setRpc, settings, TimestampMode } from ".";
import type { PresencePreset } from "./markdown";
import { LiveProfilePreview, resolvePreviewImage } from "./Preview";
import {
    blankStore,
    createNewPreset,
    deletePresetFile,
    getCachedPresets,
    loadPresetIntoStore,
    openPresetsFolder,
    refreshPresets,
    saveCurrentAsPreset,
    subscribePresets,
} from "./store";

const cl = classNameFactory("vc-arp-");

type SettingsKey = keyof typeof settings.store;

const updateRPC = debounce(() => {
    try {
        if (isPluginEnabled(AdvancedRichPresence.name)) void setRpc();
        else void setRpc(true);
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
    const s = settings.use(["activeFile", "activeName"] as never);
    const [state, setState] = useState(settings.store[settingsKey] ?? "");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setState(settings.store[settingsKey] ?? "");
        setError(null);
    }, [s.activeFile, s.activeName, settingsKey]);

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
    const [expanded, setExpanded] = useState(open);

    return (
        <div className={cl("fold")} data-expanded={expanded || undefined}>
            <button
                type="button"
                className={cl("fold-header")}
                aria-expanded={expanded}
                onClick={() => setExpanded(v => !v)}
            >
                <span className={cl("fold-title")}>{title}</span>
                <span className={cl("fold-caret")} aria-hidden>▸</span>
            </button>
            {expanded && <div className={cl("fold-body")}>{children}</div>}
        </div>
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

function PresetThumb({ src, appId, name }: { src?: string; appId?: string; name: string; }) {
    const [url, setUrl] = useState("");
    const [fallback, setFallback] = useState("");

    useEffect(() => {
        let alive = true;
        const original = String(src ?? "").trim();
        setUrl("");
        setFallback("");
        if (!original) return () => { alive = false; };

        if (/^https?:\/\//i.test(original)) {
            setUrl(original);
            void resolvePreviewImage(original, appId, 256, true).then(next => {
                if (alive && next && next !== original) setFallback(next);
            });
            return () => { alive = false; };
        }

        void resolvePreviewImage(original, appId, 256).then(next => {
            if (alive) setUrl(next);
        });
        return () => { alive = false; };
    }, [src, appId]);

    if (url) {
        return (
            <img
                className={cl("preset-art")}
                src={url}
                alt=""
                referrerPolicy="no-referrer"
                onError={() => {
                    if (fallback && fallback !== url) {
                        setUrl(fallback);
                        setFallback("");
                    } else {
                        setUrl("");
                    }
                }}
            />
        );
    }
    return (
        <div className={cl("preset-art", "preset-art-fallback")} aria-hidden>
            {(name.trim()[0] || "?").toUpperCase()}
        </div>
    );
}

function ProfileToggle() {
    const s = settings.use(["rpcEnabled"] as never);
    const enabled = s.rpcEnabled !== false;

    return (
        <SettingsSection
            tag="label"
            name="Show on my profile"
            id="rpcEnabled"
            description="Friends see the status that’s turned on. Stay Online or Idle — Invisible hides it."
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
    );
}

function PresetManager() {
    const s = settings.use(["activeFile", "rpcEnabled"] as never);
    const [presets, setPresets] = useState<PresencePreset[]>(getCachedPresets());
    const [busy, setBusy] = useState(false);

    useEffect(() => subscribePresets(setPresets), []);

    useEffect(() => {
        void refreshPresets().catch(e => toast(String(e), Toasts.Type.FAILURE));
    }, []);

    const active = s.activeFile || "";
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

    function turnOn(file: string) {
        void run(async () => {
            await loadPresetIntoStore(settings.store, file);
            settings.store.rpcEnabled = true;
            updateRPC();
            toast(`On — ${settings.store.activeName || "preset"}`);
        });
    }

    return (
        <div className={cl("section")}>
            <div className={cl("section-head")}>
                <p className={cl("section-title")}>Saved statuses</p>
            </div>
            {presets.length === 0 ? (
                <p className={cl("hint")}>Nothing saved yet. Fill this in below, then press Save preset. After that, click a picture here to turn it on.</p>
            ) : (
                <div className={cl("presets")}>
                    {presets.map(preset => {
                        const on = preset.fileName === active && enabled;
                        return (
                            <button
                                key={preset.fileName}
                                type="button"
                                className={cl("preset", on && "preset-on")}
                                title={on ? `${preset.name} is on` : `Turn on ${preset.name}`}
                                disabled={busy}
                                onClick={() => turnOn(preset.fileName)}
                            >
                                <span className={cl("preset-media")}>
                                    <PresetThumb
                                        src={preset.imageBig}
                                        appId={preset.appID}
                                        name={preset.name}
                                    />
                                    {on ? (
                                        <span className={cl("preset-overlay")} aria-hidden>
                                            <svg className={cl("preset-check")} viewBox="0 0 20 20" width="22" height="22">
                                                <circle cx="10" cy="10" r="9" fill="#fff" />
                                                <path
                                                    d="M6 10.5l2.5 2.5L14 7.5"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="1.8"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                />
                                            </svg>
                                        </span>
                                    ) : null}
                                </span>
                                <span className={cl("preset-name")}>{preset.name}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function SaveBar() {
    const s = settings.use(["activeFile", "activeName", "appName"] as never);
    const [saveName, setSaveName] = useState(String(s.activeName || s.appName || ""));
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setSaveName(String(s.activeName || s.appName || ""));
    }, [s.activeFile, s.activeName]);

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

    const hasActive = Boolean(s.activeFile);

    return (
        <div className={cl("section", "save")}>
            <div className={cl("section-head")}>
                <p className={cl("section-title")}>Save this status</p>
            </div>
            <p className={cl("hint")}>
                Fill everything in above, then save. That makes a preset you can turn on later by clicking its picture.
            </p>
            <div className={cl("save-row")}>
                <TextInput
                    value={saveName}
                    placeholder="Name, like Harvard Online or Gym"
                    onChange={setSaveName}
                />
                <Button
                    size={Button.Sizes.MEDIUM}
                    disabled={busy}
                    onClick={() => run(async () => {
                        const title = String(settings.store.appName || "").trim();
                        if (!title) {
                            toast("Fill in a title first", Toasts.Type.FAILURE);
                            return;
                        }
                        const name = saveName.trim() || title;
                        const sameSelected = Boolean(s.activeFile) && (!saveName.trim() || saveName.trim() === (s.activeName || ""));
                        const preset = sameSelected
                            ? await saveCurrentAsPreset(settings.store, name, s.activeFile)
                            : await createNewPreset(settings.store, name);
                        settings.store.rpcEnabled = true;
                        updateRPC();
                        toast(`Saved “${preset.name}”`);
                    })}
                >
                    Save preset
                </Button>
            </div>
            <div className={cl("save-actions")}>
                <Button
                    size={Button.Sizes.SMALL}
                    look={Button.Looks.LINK}
                    disabled={busy}
                    onClick={() => {
                        blankStore(settings.store);
                        setSaveName("");
                        updateRPC();
                    }}
                >
                    New blank status
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.RED}
                    look={Button.Looks.LINK}
                    disabled={busy || !hasActive}
                    onClick={() => run(async () => {
                        if (!s.activeFile) return;
                        const gone = s.activeName || "preset";
                        await deletePresetFile(settings.store, s.activeFile);
                        toast(`Deleted “${gone}”`);
                        updateRPC();
                    })}
                >
                    Delete selected
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    look={Button.Looks.LINK}
                    disabled={busy}
                    onClick={() => run(async () => { await openPresetsFolder(); })}
                >
                    Open folder
                </Button>
            </div>
        </div>
    );
}

function RpcFields() {
    const s = settings.use(["type", "timestampMode"] as never);

    return (
        <div className={cl("ml")}>
            <div className={cl("section-head")}>
                <p className={cl("section-title")}>Fill this in</p>
            </div>
            <p className={cl("hint")}>Set the title, lines, and pictures first. Save when it looks right in the preview.</p>
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
                { settingsKey: "appID", label: "App ID (optional)", isValid: isAppIdValid, placeholder: "From Developer Portal", hint: "Leave blank unless you uploaded pictures in the Developer Portal. Discord still gets an app ID so friends can see this." },
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

function pinLayout(root: HTMLDivElement) {
    const restored: Array<() => void> = [];
    const dialog = root.closest<HTMLElement>("[role='dialog']");
    dialog?.classList.add("vc-arp-open");

    const scrollers: HTMLElement[] = [];
    let node: HTMLElement | null = root.parentElement;
    while (node && node !== dialog) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") scrollers.push(node);
        node = node.parentElement;
    }

    for (const el of scrollers) {
        const prevOverflow = el.style.overflow;
        const prevOverflowY = el.style.overflowY;
        el.style.overflow = "hidden";
        el.style.overflowY = "hidden";
        restored.push(() => {
            el.style.overflow = prevOverflow;
            el.style.overflowY = prevOverflowY;
        });
    }

    const fit = () => {
        const top = root.getBoundingClientRect().top;
        const bottom = dialog?.getBoundingClientRect().bottom ?? window.innerHeight;
        const height = Math.max(280, Math.floor(Math.min(window.innerHeight, bottom) - top - 16));
        root.style.height = `${height}px`;
        root.style.maxHeight = `${height}px`;
    };

    return { dialog, fit, restored };
}

export function PresenceSettings() {
    const rootRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const { dialog, fit, restored } = pinLayout(root);
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(root.parentElement ?? root);
        if (dialog) observer.observe(dialog);
        window.addEventListener("resize", fit);
        const later = window.setTimeout(fit, 80);
        const afterAnim = window.setTimeout(fit, 320);

        return () => {
            window.clearTimeout(later);
            window.clearTimeout(afterAnim);
            window.removeEventListener("resize", fit);
            observer.disconnect();
            dialog?.classList.remove("vc-arp-open");
            root.style.height = "";
            root.style.maxHeight = "";
            restored.forEach(undo => undo());
        };
    }, []);

    return (
        <div className={cl("root")} ref={rootRef}>
            <div className={cl("pane")}>
                <ProfileToggle />
                <PresetManager />
                <RpcFields />
                <SaveBar />
            </div>
            <aside className={cl("side")}>
                <LiveProfilePreview />
            </aside>
        </div>
    );
}
