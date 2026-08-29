/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { ActivityType } from "@vencord/discord-types/enums";

import {
    applyFields,
    newId,
    parsePresetMarkdown,
    PresenceFields,
    PresencePreset,
    serializePresetMarkdown,
    slugify,
    snapshotFields,
    TimestampMode,
} from "./markdown";

const Native = VencordNative.pluginHelpers.AdvancedRichPresence as PluginNative<typeof import("./native")> | undefined;

const HARVARD_ONLINE_FILE = "harvard-online.md";
const ONLYFANS_FILE = "onlyfans.md";
const CAMERA_FILE = "camera.md";
/** Real Discord application so presence is broadcast. `name` still overrides the title. */
export const DEFAULT_RPC_APP_ID = "1260139887504392203";

const BUNDLED_PRESETS: PresencePreset[] = [
    {
        id: "arp_harvard_online",
        name: "Harvard Online",
        fileName: HARVARD_ONLINE_FILE,
        updatedAt: 0,
        appID: DEFAULT_RPC_APP_ID,
        appName: "Harvard Online",
        details: "Cybersecurity: Managing Risk in the Information Age",
        detailsURL: "https://harvardonline.harvard.edu/",
        type: ActivityType.PLAYING,
        timestampMode: TimestampMode.TIME,
        imageBig: "https://static-prod.logosoftwear.com/img/applications/library/design-tips/the-meanings-of-20-university-logos/harvard-logo.jpg",
        imageBigTooltip: "Playing Harvard Online on Windows 11",
        imageSmall: "https://media3.giphy.com/media/v1.Y2lkPTZjMDliOTUyNml6b2J2NnVvdWczNGlrZmIzcTZkOWNkczU4eHc5dTVxMmd4aHphciZlcD12MV9zdGlja2Vyc19zZWFyY2gmY3Q9cw/ymOQcf85Q5zrkBrhPM/source.gif",
        imageSmallTooltip: "Verified",
        buttonOneText: "Learn More",
        buttonOneURL: "https://harvardonline.harvard.edu/",
    },
    {
        id: "arp_onlyfans",
        name: "OnlyFans",
        fileName: ONLYFANS_FILE,
        updatedAt: 0,
        appID: DEFAULT_RPC_APP_ID,
        appName: "OnlyFans",
        details: "I know you're curious",
        type: ActivityType.PLAYING,
        timestampMode: TimestampMode.TIME,
        imageBig: "https://www.edigitalagency.com.au/wp-content/uploads/OnlyFans-logo-symbol-icon-png-blue-background-300x300.png",
        imageBigTooltip: "OnlyFans",
        buttonOneText: "About me",
        buttonOneURL: "https://www.youtube.com/watch?v=QDia3e12czc",
    },
    {
        id: "arp_camera",
        name: "Camera",
        fileName: CAMERA_FILE,
        updatedAt: 0,
        appID: DEFAULT_RPC_APP_ID,
        appName: "Camera",
        details: "iOS 26.6.1",
        type: ActivityType.PLAYING,
        timestampMode: TimestampMode.TIME,
        imageBig: "https://static.wikia.nocookie.net/ipod/images/5/58/IOS26CameraIcon.webp/revision/latest/scale-to-width-down/250?cb=20250907020904",
        imageBigTooltip: "Camera",
    }
];

async function ensureBundledPresets() {
    if (!Native) return;
    for (const preset of BUNDLED_PRESETS) {
        const exists = await Native.fileExists(preset.fileName);
        if (exists.ok && exists.data === "1") continue;
        const res = await Native.writePresetFile(
            preset.fileName,
            serializePresetMarkdown({ ...preset, updatedAt: Date.now() })
        );
        if (!res.ok) console.error("[AdvancedRichPresence] failed to add preset", preset.name, res.data);
    }
}

export type StoreShape = PresenceFields & {
    rpcEnabled?: boolean;
    activeFile?: string;
    activeName?: string;
    notes?: string;
};

let cache: PresencePreset[] = [];
const listeners = new Set<(list: PresencePreset[]) => void>();
let refreshGen = 0;

export function getCachedPresets() {
    return cache;
}

export function subscribePresets(cb: (list: PresencePreset[]) => void) {
    listeners.add(cb);
    cb(cache);
    return () => { listeners.delete(cb); };
}

function setCache(next: PresencePreset[]) {
    cache = next.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const cb of listeners) cb(cache);
}

function upsertCache(preset: PresencePreset) {
    setCache([...cache.filter(p => p.fileName !== preset.fileName), preset]);
}

function uniqueDisplayName(desired: string) {
    const base = desired.trim() || "New preset";
    const taken = new Set(cache.map(p => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`;
}

function uniqueFileName(desired: string) {
    const slug = slugify(desired);
    let file = `${slug}.md`;
    let n = 2;
    while (cache.some(p => p.fileName.toLowerCase() === file.toLowerCase())) {
        file = `${slug}-${n}.md`;
        n++;
    }
    return file;
}

async function writeAndSelect(store: StoreShape, preset: PresencePreset) {
    if (!Native) throw new Error("Desktop Discord required for presets");
    const res = await Native.writePresetFile(preset.fileName, serializePresetMarkdown(preset));
    if (!res.ok) throw new Error(res.data);
    applyFields(store, snapshotFields(preset));
    (store as any).notes = preset.notes || "";
    store.activeFile = preset.fileName;
    store.activeName = preset.name;
    upsertCache(preset);
    void refreshPresets();
    return preset;
}

export async function refreshPresets(): Promise<PresencePreset[]> {
    const gen = ++refreshGen;
    if (!Native) {
        if (gen === refreshGen) setCache([]);
        return cache;
    }
    await ensureBundledPresets();
    await Native.getPresetsDir();
    const listed = await Native.listPresetFiles();
    if (gen !== refreshGen) return cache;
    if (!listed.ok) {
        setCache([]);
        return cache;
    }
    let files: string[] = [];
    try { files = JSON.parse(listed.data); } catch { files = []; }

    const out: PresencePreset[] = [];
    for (const file of files) {
        const res = await Native.readPresetFile(file);
        if (gen !== refreshGen) return cache;
        if (!res.ok) continue;
        const preset = parsePresetMarkdown(file, res.data);
        if (preset) out.push(preset);
    }
    if (gen === refreshGen) setCache(out);
    return cache;
}

export async function createNewPreset(store: StoreShape, name: string) {
    if (!Native) throw new Error("Desktop Discord required for presets");
    const display = uniqueDisplayName(name);
    return writeAndSelect(store, {
        id: newId(),
        name: display,
        fileName: uniqueFileName(display),
        updatedAt: Date.now(),
        notes: store.notes,
        ...snapshotFields(store),
        appName: store.appName?.trim() || display,
        type: store.type ?? ActivityType.PLAYING,
        timestampMode: store.timestampMode ?? TimestampMode.TIME,
    });
}

export async function duplicatePreset(store: StoreShape, fileName: string) {
    const src = cache.find(p => p.fileName === fileName)
        || (await refreshPresets()).find(p => p.fileName === fileName);
    if (!src) throw new Error("Preset not found");
    const display = uniqueDisplayName(`${src.name} copy`);
    return writeAndSelect(store, {
        ...src,
        id: newId(),
        name: display,
        fileName: uniqueFileName(display),
        updatedAt: Date.now(),
    });
}

export async function saveCurrentAsPreset(store: StoreShape, name: string, overwriteFile?: string) {
    if (!Native) throw new Error("Desktop Discord required for .md presets");
    const fileName = overwriteFile || `${slugify(name)}.md`;
    const existing = cache.find(p => p.fileName === fileName);
    const preset: PresencePreset = {
        id: existing?.id || newId(),
        name: name.trim() || "Untitled",
        fileName,
        updatedAt: Date.now(),
        notes: (store as any).notes,
        ...snapshotFields(store),
    };
    const res = await Native.writePresetFile(fileName, serializePresetMarkdown(preset));
    if (!res.ok) throw new Error(res.data);
    store.activeFile = fileName;
    store.activeName = preset.name;
    upsertCache(preset);
    void refreshPresets();
    return preset;
}

export function blankStore(store: StoreShape) {
    applyFields(store, {});
    store.notes = "";
    store.activeFile = undefined;
    store.activeName = undefined;
}

export async function loadPresetIntoStore(store: StoreShape, fileName: string) {
    const preset = cache.find(p => p.fileName === fileName)
        || (await refreshPresets()).find(p => p.fileName === fileName);
    if (!preset) return false;
    const { id: _i, name: _n, fileName: _f, updatedAt: _u, notes: _notes, ...fields } = preset;
    applyFields(store, fields);
    (store as any).notes = preset.notes || "";
    store.activeFile = preset.fileName;
    store.activeName = preset.name;
    return true;
}

export async function deletePresetFile(store: StoreShape, fileName: string) {
    if (!Native) throw new Error("Desktop Discord required");
    const res = await Native.deletePresetFile(fileName);
    if (!res.ok) throw new Error(res.data);
    setCache(cache.filter(p => p.fileName !== fileName));
    if (store.activeFile === fileName) {
        if (cache[0]) await loadPresetIntoStore(store, cache[0].fileName);
        else {
            store.activeFile = undefined;
            store.activeName = undefined;
        }
    }
    void refreshPresets();
}

export async function renamePreset(store: StoreShape, fileName: string, newName: string) {
    if (!Native) throw new Error("Desktop Discord required");
    const preset = cache.find(p => p.fileName === fileName);
    if (!preset) throw new Error("Preset not found");
    const nextFile = `${slugify(newName)}.md`;
    const updated: PresencePreset = {
        ...preset,
        name: newName.trim() || preset.name,
        fileName: nextFile,
        updatedAt: Date.now(),
    };
    const write = await Native.writePresetFile(nextFile, serializePresetMarkdown(updated));
    if (!write.ok) throw new Error(write.data);
    if (nextFile !== fileName)
        await Native.deletePresetFile(fileName);
    if (store.activeFile === fileName) {
        store.activeFile = nextFile;
        store.activeName = updated.name;
    }
    setCache([...cache.filter(p => p.fileName !== fileName && p.fileName !== nextFile), updated]);
    void refreshPresets();
    return updated;
}

export async function openPresetsFolder() {
    if (!Native) throw new Error("Desktop Discord required");
    return Native.openPresetsFolder();
}
