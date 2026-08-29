/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getUserSettingLazy } from "@api/UserSettings";
import { classNameFactory } from "@utils/css";
import { ActivityType } from "@vencord/discord-types/enums";
import {
    ApplicationAssetUtils,
    IconUtils,
    PresenceStore,
    useEffect,
    useRef,
    UserProfileStore,
    UserStore,
    useState,
    useStateFromStores,
} from "@webpack/common";
import type { CSSProperties } from "react";

import { getOwnBadgeShare, refreshUserProfile } from "../_delexo/liveShare";
import { profileBadgesFromShare } from "../badges/render";
import { stripShare } from "../badges/share";
import { settings } from ".";
import { resolveTemplate, TimestampMode } from "./markdown";

const cl = classNameFactory("vc-arp-");
const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

const PREVIEW_KEYS = [
    "rpcEnabled",
    "appID",
    "appName",
    "details",
    "detailsURL",
    "state",
    "stateURL",
    "type",
    "streamLink",
    "timestampMode",
    "startTime",
    "endTime",
    "imageBig",
    "imageBigURL",
    "imageBigTooltip",
    "imageSmall",
    "imageSmallURL",
    "imageSmallTooltip",
    "buttonOneText",
    "buttonOneURL",
    "buttonTwoText",
    "buttonTwoURL",
    "partySize",
    "partyMaxSize",
    "activeName",
    "activeFile",
] as const;

function typePrefix(type: ActivityType): string {
    switch (type) {
        case ActivityType.PLAYING:
            return "Playing";
        case ActivityType.STREAMING:
            return "Streaming";
        case ActivityType.LISTENING:
            return "Listening to";
        case ActivityType.WATCHING:
            return "Watching";
        case ActivityType.CUSTOM_STATUS:
            return "Playing";
        case ActivityType.COMPETING:
            return "Competing in";
        case ActivityType.HANG_STATUS:
            return "Playing";
        default: {
            const _exhaustive: never = type;
            void _exhaustive;
            return "Playing";
        }
    }
}

function formatClock(ms: number) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
}

function isHttp(value?: string) {
    return Boolean(value && /^https?:\/\//i.test(value));
}

function openUrl(url?: string) {
    const href = String(url ?? "").trim();
    if (!isHttp(href)) return;
    try {
        VencordNative.native.openExternal(href);
    } catch {
        window.open(href, "_blank", "noopener,noreferrer");
    }
}

function assetKeyToUrl(id: string, appId: string | undefined, size: number) {
    const key = String(id ?? "").trim();
    if (!key) return "";
    if (isHttp(key)) return key;
    if (key.startsWith("mp:")) {
        const path = key.slice(3).replace(/^\/+/, "");
        return isHttp(path) ? path : `https://media.discordapp.net/${path}`;
    }
    if (!appId) return "";
    const idOnly = key.replace(/\.png$/i, "");
    return `https://cdn.discordapp.com/app-assets/${appId}/${idOnly}.png?size=${size}`;
}

function withPngFormat(url: string) {
    if (!url.includes("media.discordapp.net") && !url.includes("cdn.discordapp.com")) return url;
    if (/[?&]format=/i.test(url)) return url;
    return url.includes("?") ? `${url}&format=png` : `${url}?format=png`;
}

export async function resolvePreviewImage(key: string | undefined, appId: string | undefined, size = 256, forceProxy = false) {
    const raw = String(key ?? "").trim();
    if (!raw) return "";
    // Direct links keep PNG alpha. Discord's asset proxy often flattens it to a white box.
    if (isHttp(raw) && !forceProxy) return raw;

    let resolved = raw;
    if (appId) {
        try {
            resolved = String((await ApplicationAssetUtils.fetchAssetIds(appId, [raw]))[0] || raw);
        } catch {
            resolved = raw;
        }
        try {
            const tryGet = (app: unknown) => {
                try {
                    const fromUtil = ApplicationAssetUtils.getAssetImage?.(app, resolved, size);
                    return typeof fromUtil === "string" && fromUtil ? fromUtil : "";
                } catch {
                    return "";
                }
            };
            const fromUtil = tryGet(appId) || tryGet({ id: appId });
            if (fromUtil) return withPngFormat(fromUtil);
        } catch { /* Discord build differences */ }
    }

    return withPngFormat(assetKeyToUrl(resolved, appId, size) || assetKeyToUrl(raw, appId, size));
}

function bannerStyle(userId: string | undefined, profile: { banner?: string | null; accentColor?: number | null; } | undefined): CSSProperties {
    if (userId && profile?.banner) {
        const url = IconUtils.getUserBannerURL({
            id: userId,
            banner: profile.banner,
            canAnimate: true,
            size: 480
        });
        if (url) {
            return {
                backgroundImage: `url(${url})`,
                backgroundSize: "cover",
                backgroundPosition: "center"
            };
        }
    }
    if (typeof profile?.accentColor === "number" && profile.accentColor > 0) {
        return { backgroundColor: `#${profile.accentColor.toString(16).padStart(6, "0")}` };
    }
    return { backgroundColor: "var(--background-tertiary, #1e1f22)" };
}

function PreviewArt({
    src,
    className,
    href,
    label,
    small
}: {
    src?: string;
    className: string;
    href?: string;
    label?: string;
    small?: boolean;
}) {
    const appId = String(settings.store.appID ?? "");
    const [url, setUrl] = useState("");
    const [fallback, setFallback] = useState("");
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        setFailed(false);
        const original = String(src ?? "").trim();

        if (isHttp(original)) {
            setUrl(original);
            setFallback("");
            if (appId) {
                void resolvePreviewImage(original, appId, small ? 128 : 256, true).then(next => {
                    if (alive && next && next !== original) setFallback(next);
                });
            }
            return () => { alive = false; };
        }

        setFallback("");
        void resolvePreviewImage(src, appId, small ? 128 : 256).then(next => {
            if (alive) setUrl(next);
        });
        return () => { alive = false; };
    }, [src, appId, small]);

    if (!url || failed)
        return <div className={className} aria-hidden />;

    const img = (
        <img
            className={className}
            src={url}
            alt=""
            title={label}
            referrerPolicy="no-referrer"
            onError={() => {
                if (fallback && fallback !== url) {
                    setUrl(fallback);
                    setFallback("");
                    return;
                }
                setFailed(true);
            }}
        />
    );

    if (!isHttp(href)) return img;
    return (
        <button
            type="button"
            className={cl("profile-art-btn", small && "profile-art-btn-small")}
            title={label || href}
            onClick={() => openUrl(href)}
        >
            {img}
        </button>
    );
}

function clanBadgeUrl(clan: { badge?: string; identityGuildId?: string; } | null | undefined) {
    if (!clan?.badge || !clan.identityGuildId) return "";
    return `https://cdn.discordapp.com/clan-badges/${clan.identityGuildId}/${clan.badge}.png?size=32`;
}

function discordBadgeSrc(badge: { icon?: string; iconSrc?: string; }) {
    if (badge.iconSrc) return badge.iconSrc;
    const icon = badge.icon ?? "";
    if (!icon) return "";
    if (/^https?:\/\//.test(icon)) return icon;
    return `https://cdn.discordapp.com/badge-icons/${icon}.png`;
}

function ClickableLine({ text, href }: { text: string; href?: string; }) {
    if (!text) return null;
    if (isHttp(href)) {
        return (
            <button type="button" className={cl("profile-line", "profile-link")} onClick={() => openUrl(href)}>
                {text}
            </button>
        );
    }
    return <div className={cl("profile-line")}>{text}</div>;
}

function GamepadIcon() {
    return (
        <svg className={cl("profile-timer-icon")} width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M17.5 6.5A5.5 5.5 0 0 1 22.7 14l-2.7 5.7a2.5 2.5 0 0 1-4.52.3L14.2 18H9.8l-1.28 2a2.5 2.5 0 0 1-4.52-.3L1.3 14A5.5 5.5 0 0 1 12.5 6h5ZM8 11a1 1 0 1 0 0 2h.01A1 1 0 0 0 8 11Zm8 0a1 1 0 1 0 0 2h.01A1 1 0 0 0 16 11ZM9 11H7v2h2v-2Zm8 0h-2v2h2v-2Z" />
        </svg>
    );
}

export function LiveProfilePreview() {
    const s = settings.use(PREVIEW_KEYS as never);
    const gameActivityEnabled = ShowCurrentGame.useSetting();
    const [, setTick] = useState(0);
    const nowStart = useRef(Date.now());

    const me = useStateFromStores([UserStore], () => UserStore.getCurrentUser());
    const profile = useStateFromStores(
        [UserProfileStore],
        () => me ? UserProfileStore.getUserProfile(me.id) : undefined
    );
    const presence = useStateFromStores([PresenceStore], () => {
        if (!me) return { status: "offline" as const, text: "", emojiUrl: "", emojiName: "" };
        const custom = PresenceStore.getActivities(me.id)?.find(a => a.type === ActivityType.CUSTOM_STATUS);
        const emoji = custom?.emoji;
        return {
            status: PresenceStore.getStatus(me.id) ?? "offline",
            text: custom?.state ?? "",
            emojiUrl: emoji?.id
                ? `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}?size=32`
                : "",
            emojiName: emoji?.name ?? ""
        };
    });

    useEffect(() => {
        if (!me?.id) return;
        void refreshUserProfile(me.id, true).catch(() => undefined);
    }, [me?.id]);

    useEffect(() => {
        const id = window.setInterval(() => setTick(n => n + 1), 1000);
        return () => window.clearInterval(id);
    }, []);

    const displayName = me?.globalName || me?.username || "You";
    const userName = me?.username || "";
    const bio = stripShare(profile?.bio ?? "").trim();
    const pronouns = String(profile?.pronouns ?? "").trim();
    const clan = me?.primaryGuild;
    const showClan = Boolean(clan && clan.identityEnabled !== false && clan.tag);
    const nameplate = me?.collectibles?.nameplate;
    const officialBadges = (profile?.badges ?? [])
        .map((badge, i) => ({
            key: badge.id || `official-${i}`,
            src: discordBadgeSrc(badge),
            title: badge.description || badge.id || "Badge"
        }))
        .filter(badge => badge.src);
    const extraBadges = me
        ? profileBadgesFromShare(getOwnBadgeShare(), me.id).map(badge => ({
            key: badge.id,
            src: String(badge.iconSrc || ""),
            title: badge.description || "Badge"
        })).filter(badge => badge.src)
        : [];
    const seenBadge = new Set(officialBadges.map(b => b.src));
    const badges = [...officialBadges, ...extraBadges.filter(b => !seenBadge.has(b.src))];
    const hasCustom = Boolean(presence.text || presence.emojiUrl || presence.emojiName);
    const title = String(s.appName || "").trim();
    const details = resolveTemplate(s.details, s.activeName, displayName);
    const state = resolveTemplate(s.state, s.activeName, displayName);
    const type = s.type ?? ActivityType.PLAYING;
    const enabled = s.rpcEnabled !== false;
    const partySize = Number(s.partySize) || 0;
    const partyMax = Number(s.partyMaxSize) || 0;
    const actions = [
        { label: String(s.buttonOneText ?? "").trim(), url: String(s.buttonOneURL ?? "").trim() },
        { label: String(s.buttonTwoText ?? "").trim(), url: String(s.buttonTwoURL ?? "").trim() }
    ].filter(item => item.label);
    const titleHref = (s.type === ActivityType.STREAMING && s.streamLink) || undefined;
    const statusClass = presence.status === "idle" || presence.status === "dnd"
        || presence.status === "online" || presence.status === "streaming"
        || presence.status === "invisible" || presence.status === "offline"
        ? presence.status
        : "offline";

    const mode = s.timestampMode ?? TimestampMode.TIME;
    let timer: string | null = null;
    switch (mode) {
        case TimestampMode.NONE:
            timer = null;
            break;
        case TimestampMode.NOW:
            timer = formatClock(Date.now() - nowStart.current);
            break;
        case TimestampMode.TIME: {
            const now = new Date();
            const start = Date.now() - (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000;
            timer = formatClock(Date.now() - start);
            break;
        }
        case TimestampMode.CUSTOM: {
            const start = Number(s.startTime) || 0;
            const end = Number(s.endTime) || 0;
            if (end && end > Date.now()) timer = formatClock(end - Date.now());
            else if (start) timer = formatClock(Date.now() - start);
            else timer = null;
            break;
        }
        default: {
            const _exhaustive: never = mode;
            void _exhaustive;
            timer = null;
            break;
        }
    }

    return (
        <div className={cl("profile-preview")}>
            <div className={cl("profile-kicker")}>Profile</div>
            <div className={cl("profile-popout")}>
                <div className={cl("profile-banner")} style={bannerStyle(me?.id, profile)} />
                <div className={cl("profile-body")}>
                    <div className={cl("profile-avatar-row")}>
                        {me && (
                            <div className={cl("profile-avatar-wrap")}>
                                <img
                                    className={cl("profile-avatar")}
                                    src={me.getAvatarURL(void 0, 128, true)}
                                    alt=""
                                />
                                <span className={cl("profile-status", `profile-status-${statusClass}`)} />
                            </div>
                        )}
                        {hasCustom && (
                            <div className={cl("profile-custom")}>
                                {presence.emojiUrl
                                    ? <img src={presence.emojiUrl} alt="" />
                                    : presence.emojiName
                                        ? <span className={cl("profile-custom-emoji")}>{presence.emojiName}</span>
                                        : <span className={cl("profile-custom-plus")}>+</span>}
                                {presence.text
                                    ? <span className={cl("profile-custom-text")}>{presence.text}</span>
                                    : null}
                            </div>
                        )}
                    </div>
                    <div className={cl("profile-display")}>{displayName}</div>
                    <div className={cl("profile-meta")}>
                        {userName ? <span className={cl("profile-handle")}>@{userName}</span> : null}
                        {pronouns ? <span className={cl("profile-dot")}>•</span> : null}
                        {pronouns ? <span className={cl("profile-pronouns")}>{pronouns}</span> : null}
                        {showClan && clan ? (
                            <>
                                <span className={cl("profile-dot")}>•</span>
                                <span className={cl("profile-tag")} title={clan.tag}>
                                    {clanBadgeUrl(clan) ? <img src={clanBadgeUrl(clan)} alt="" /> : null}
                                    {clan.tag}
                                </span>
                            </>
                        ) : null}
                        {nameplate?.label ? (
                            <span className={cl("profile-tag", "profile-tag-plate")}>{nameplate.label}</span>
                        ) : null}
                    </div>
                    {badges.length > 0 && (
                        <div className={cl("profile-badges")} aria-label="Profile badges">
                            {badges.map(badge => (
                                <img key={badge.key} src={badge.src} alt={badge.title} title={badge.title} />
                            ))}
                        </div>
                    )}
                    {bio ? (
                        <div className={cl("profile-about")}>
                            <div className={cl("profile-about-label")}>About Me</div>
                            <div className={cl("profile-bio")}>{bio}</div>
                        </div>
                    ) : null}

                    {enabled && title ? (
                    <div className={cl("profile-card")}>
                        <div className={cl("profile-card-head")}>
                            <span>{typePrefix(type)}</span>
                            <span className={cl("profile-menu")} aria-hidden>⋯</span>
                        </div>
                        <div className={cl("profile-card-body")}>
                            <div className={cl("profile-art-wrap")}>
                                <PreviewArt
                                    src={s.imageBig}
                                    className={cl("profile-art")}
                                    href={s.imageBigURL}
                                    label={s.imageBigTooltip}
                                />
                                {s.imageSmall && (
                                    <PreviewArt
                                        src={s.imageSmall}
                                        className={cl("profile-art-small")}
                                        href={s.imageSmallURL}
                                        label={s.imageSmallTooltip}
                                        small
                                    />
                                )}
                            </div>
                            <div className={cl("profile-copy")}>
                                {isHttp(titleHref) ? (
                                    <button
                                        type="button"
                                        className={cl("profile-title", "profile-link")}
                                        onClick={() => openUrl(titleHref)}
                                    >
                                        {title}
                                    </button>
                                ) : (
                                    <div className={cl("profile-title")}>{title}</div>
                                )}
                                <ClickableLine text={details} href={s.detailsURL} />
                                <ClickableLine text={state} href={s.stateURL} />
                                {partySize > 0 && partyMax > 0 && (
                                    <div className={cl("profile-line")}>{partySize} of {partyMax}</div>
                                )}
                                {timer && (
                                    <div className={cl("profile-timer")}>
                                        <GamepadIcon />
                                        <span>{timer}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        {actions.length > 0 && (
                            <div className={cl("profile-btns")}>
                                {actions.map(item => (
                                    <button
                                        key={item.label}
                                        type="button"
                                        className={cl("profile-btn")}
                                        disabled={!isHttp(item.url)}
                                        title={isHttp(item.url) ? item.url : "Add a link on the left to make this clickable"}
                                        onClick={() => openUrl(item.url)}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    ) : enabled ? (
                        <div className={cl("profile-card")}>
                            <div className={cl("profile-empty")}>Type a title on the left to see it here.</div>
                        </div>
                    ) : null}
                </div>
            </div>
            <div className={cl("profile-note")}>
                {enabled
                    ? "Updates as you type. Friends see this on your profile."
                    : "Preview only — turn on “Show on my profile” to share it."}
            </div>
            {!gameActivityEnabled && (
                <div className={cl("profile-warn")}>
                    Activity sharing is off in Discord, so friends won’t see this until you turn it on in Status settings.
                </div>
            )}
        </div>
    );
}
