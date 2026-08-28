/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getUserSettingLazy } from "@api/UserSettings";
import { classNameFactory } from "@utils/css";
import { ActivityType } from "@vencord/discord-types/enums";
import {
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

import { settings } from ".";
import { resolveTemplate, TimestampMode } from "./markdown";

const cl = classNameFactory("vc-arp-");
const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

const PREVIEW_KEYS = [
    "rpcEnabled",
    "appName",
    "details",
    "state",
    "type",
    "timestampMode",
    "startTime",
    "endTime",
    "imageBig",
    "imageSmall",
    "buttonOneText",
    "buttonTwoText",
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

function PreviewArt({ src, className }: { src?: string; className: string; }) {
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setFailed(false);
    }, [src]);

    if (!isHttp(src) || failed)
        return <div className={className} aria-hidden />;

    return (
        <img
            className={className}
            src={src}
            alt=""
            onError={() => setFailed(true)}
        />
    );
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
    const status = useStateFromStores(
        [PresenceStore],
        () => (me ? PresenceStore.getStatus(me.id) : "offline") ?? "offline"
    );

    useEffect(() => {
        nowStart.current = Date.now();
    }, [s.timestampMode, s.startTime, s.endTime, s.activeFile]);

    useEffect(() => {
        const id = window.setInterval(() => setTick(n => n + 1), 1000);
        return () => window.clearInterval(id);
    }, []);

    const displayName = me?.globalName || me?.username || "You";
    const userName = me?.username || "";
    const title = String(s.appName || "").trim();
    const details = resolveTemplate(s.details, s.activeName, displayName);
    const state = resolveTemplate(s.state, s.activeName, displayName);
    const type = s.type ?? ActivityType.PLAYING;
    const enabled = s.rpcEnabled !== false;
    const partySize = Number(s.partySize) || 0;
    const partyMax = Number(s.partyMaxSize) || 0;
    const buttons = [s.buttonOneText, s.buttonTwoText].filter(Boolean) as string[];
    const statusClass = status === "idle" || status === "dnd"
        || status === "online" || status === "streaming"
        || status === "invisible" || status === "offline"
        ? status
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
                    </div>
                    <div className={cl("profile-display")}>{displayName}</div>
                    {userName && <div className={cl("profile-handle")}>{userName}</div>}

                    <div className={cl("profile-card")}>
                        {!title ? (
                            <div className={cl("profile-empty")}>Type a title on the left to see it here.</div>
                        ) : (
                            <>
                                <div className={cl("profile-card-head")}>
                                    <span>{typePrefix(type)}</span>
                                    <span className={cl("profile-menu")} aria-hidden>⋯</span>
                                </div>
                                <div className={cl("profile-card-body")}>
                                    <div className={cl("profile-art-wrap")}>
                                        <PreviewArt src={s.imageBig} className={cl("profile-art")} />
                                        {isHttp(s.imageSmall) && (
                                            <PreviewArt src={s.imageSmall} className={cl("profile-art-small")} />
                                        )}
                                    </div>
                                    <div className={cl("profile-copy")}>
                                        <div className={cl("profile-title")}>{title}</div>
                                        {details && <div className={cl("profile-line")}>{details}</div>}
                                        {state && <div className={cl("profile-line")}>{state}</div>}
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
                                {buttons.length > 0 && (
                                    <div className={cl("profile-btns")}>
                                        {buttons.map((label, i) => (
                                            <div key={`${i}-${label}`} className={cl("profile-btn")}>{label}</div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
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
