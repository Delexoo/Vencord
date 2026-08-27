/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function svgUri(svg: string) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function badge(id: string, from: string, to: string, art: string) {
    return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<defs>
<linearGradient id="${id}" x1="12" y1="4" x2="52" y2="60" gradientUnits="userSpaceOnUse">
<stop stop-color="${from}"/>
<stop offset="1" stop-color="${to}"/>
</linearGradient>
<filter id="${id}s" x="-20%" y="-20%" width="140%" height="140%">
<feDropShadow dx="0" dy="2" stdDeviation="1.4" flood-color="#000" flood-opacity=".45"/>
</filter>
</defs>
<circle cx="32" cy="32" r="30" fill="url(#${id})" stroke="#fff" stroke-opacity=".28" stroke-width="2"/>
<circle cx="22" cy="18" r="14" fill="#fff" fill-opacity=".16"/>
<g filter="url(#${id}s)">${art}</g>
</svg>`);
}

export const ICONS = {
    nightCircuit: badge(
        "nc",
        "#1b1f4a",
        "#5ee7ff",
        `<path fill="none" stroke="#d9fbff" stroke-width="3" stroke-linecap="round" d="M18 40h8l4-8 6 12 5-9h5"/>
<rect x="18" y="18" width="28" height="16" rx="3" fill="none" stroke="#9ef6ff" stroke-width="2.5"/>
<circle cx="24" cy="26" r="2.2" fill="#9ef6ff"/>
<circle cx="32" cy="26" r="2.2" fill="#9ef6ff"/>
<circle cx="40" cy="26" r="2.2" fill="#9ef6ff"/>`
    ),
    emberSigil: badge(
        "es",
        "#3a0d08",
        "#ff7a18",
        `<path fill="#ffe1a8" d="M32 14c6 8 2 12 2 18 0 8 8 10 8 10-6 10-20 10-22 0 4 2 8-2 8-8 0-8-4-12 4-20z"/>
<path fill="#ff5a1f" d="M32 28c3 4 1 7 1 10 0 4 4 5 4 5-3 5-11 5-12 0 2 1 4-1 4-4 0-4-2-6 3-11z"/>`
    ),
    lunarDrift: badge(
        "ld",
        "#0b1c3a",
        "#7aa2ff",
        `<path fill="#eef4ff" d="M38 16a16 16 0 1 0 8 28 18 18 0 1 1-8-28z"/>
<circle cx="44" cy="18" r="2" fill="#cfe0ff"/>
<circle cx="48" cy="26" r="1.4" fill="#cfe0ff"/>`
    ),
    aetherBloom: badge(
        "ab",
        "#2a0854",
        "#5dffc5",
        `<circle cx="32" cy="32" r="5" fill="#fff7b0"/>
<path fill="#b8ffe6" d="M32 14c4 8 4 12 0 18-4-6-4-10 0-18zM32 50c-4-8-4-12 0-18 4 6 4 10 0 18zM14 32c8-4 12-4 18 0-6 4-10 4-18 0zM50 32c-8 4-12 4-18 0 6-4 10-4 18 0z"/>
<path fill="#7dffd0" d="M20 20c6 4 8 8 12 12-4-4-8-6-12-12zM44 20c-6 4-8 8-12 12 4-4 8-6 12-12zM20 44c6-4 8-8 12-12-4 4-8 6-12 12zM44 44c-6-4-8-8-12-12 4 4 8 6 12 12z"/>`
    ),
    ironVeil: badge(
        "iv",
        "#1c2430",
        "#9aa6b8",
        `<path fill="#e8edf4" d="M32 12 48 18v14c0 11-7 18-16 22-9-4-16-11-16-22V18z"/>
<path fill="#5d6b7e" d="M32 18 44 22v10c0 8-5 13-12 16-7-3-12-8-12-16V22z"/>
<path fill="none" stroke="#cfd8e6" stroke-width="2.4" d="M32 22v24M24 30h16"/>`
    ),
    stormcall: badge(
        "sc",
        "#10245c",
        "#ffe14a",
        "<path fill=\"#fff4a8\" d=\"m34 12-16 22h12l-4 18 22-26H36l8-14z\"/>"
    ),
    voidglass: badge(
        "vg",
        "#14061f",
        "#c46bff",
        `<path fill="#f0d9ff" d="M32 10 48 32 32 54 16 32z"/>
<path fill="#9b4dff" d="M32 18 42 32 32 46 22 32z"/>
<path fill="#fff" fill-opacity=".55" d="M32 18 28 32 32 46 30 32z"/>`
    ),
    riftwalker: badge(
        "rw",
        "#042a2c",
        "#3dffe8",
        `<circle cx="32" cy="32" r="16" fill="none" stroke="#d7fff8" stroke-width="3"/>
<circle cx="32" cy="32" r="9" fill="none" stroke="#7dfff0" stroke-width="3"/>
<circle cx="32" cy="32" r="3.5" fill="#e9fffb"/>
<path fill="none" stroke="#9dfff4" stroke-width="2.4" stroke-linecap="round" d="M32 8v8M32 48v8M8 32h8M48 32h8"/>`
    ),
} as const;
