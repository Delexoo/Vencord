/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Dev } from "@utils/constants";

/** Self-contained so Delexo plugins overlay onto official Vencord without core patches. */
export const Delexo: Dev = {
    name: "Delexo",
    id: 812938158806794281n,
    badge: false
};

export const DELEXO_DISCORD_ID = Delexo.id;

export default Delexo;
