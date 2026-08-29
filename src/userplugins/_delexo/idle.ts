/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Coalesce bursty DOM work into one timeout. */
export function scheduleOnce(ms: number) {
    let id = 0;
    return {
        run(fn: () => void) {
            if (id) return;
            id = window.setTimeout(() => {
                id = 0;
                fn();
            }, ms);
        },
        cancel() {
            if (id) window.clearTimeout(id);
            id = 0;
        }
    };
}

/** True when a mutation target or added/removed node class matches. */
export function mutationClassMatches(records: MutationRecord[], re: RegExp) {
    for (const rec of records) {
        const target = rec.target;
        if (target instanceof Element) {
            const cn = target.className;
            if (typeof cn === "string" && re.test(cn)) return true;
        }
        for (const node of rec.addedNodes) {
            if (node instanceof Element) {
                const cn = node.className;
                if (typeof cn === "string" && re.test(cn)) return true;
            }
        }
        for (const node of rec.removedNodes) {
            if (node instanceof Element) {
                const cn = node.className;
                if (typeof cn === "string" && re.test(cn)) return true;
            }
        }
    }
    return false;
}
