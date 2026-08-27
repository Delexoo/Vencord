/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Delexo contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Official Discord badge art from badge-icons PNGs or assets/content SVGs. */

export function badgeIcon(hash: string) {
    if (/^https?:\/\//.test(hash)) return hash;
    if (hash.length === 64) return `https://cdn.discordapp.com/assets/content/${hash}.svg`;
    return `https://cdn.discordapp.com/badge-icons/${hash}.png`;
}

export const HELP_ARTICLE = "https://support.discord.com/hc/en-us/articles/360035962891-Profile-Badges-101";

export type BadgeSection = "common" | "rare" | "legacy" | "experiment" | "unobtainable";

export interface BadgeOption {
    id: string;
    discordId: string;
    name: string;
    description: string;
    hash: string;
    link?: string;
}

export interface ChoiceGroup {
    key: string;
    label: string;
    description: string;
    section: BadgeSection;
    options: BadgeOption[];
}

export interface ToggleBadge extends BadgeOption {
    section: BadgeSection;
}

export const SECTION_LABELS: Record<BadgeSection, string> = {
    common: "Common Profile Badges",
    rare: "Rare Badges",
    legacy: "Legacy Badges",
    experiment: "Experiments",
    unobtainable: "Unobtainable",
};

export const CHOICE_GROUPS: ChoiceGroup[] = [
    {
        key: "nitro",
        label: "Discord Nitro",
        description: "Anyone with Nitro, Nitro Classic, or Nitro Basic. Hover shows how long they've been subscribed.",
        section: "common",
        options: [
            { id: "premium", discordId: "premium", name: "Nitro", description: "Discord Nitro subscriber", hash: "2ba85e8026a8614b640c2837bcdfe21b", link: "https://discord.com/settings/premium" },
            { id: "bronze", discordId: "premium_tenure_1_month_v2", name: "Nitro Bronze", description: "1 month: Bronze", hash: "4f33c4a9c64ce221936bd256c356f91f", link: "https://discord.com/settings/premium" },
            { id: "silver", discordId: "premium_tenure_3_month_v2", name: "Nitro Silver", description: "3 months: Silver", hash: "4514fab914bdbfb4ad2fa23df76121a6", link: "https://discord.com/settings/premium" },
            { id: "gold", discordId: "premium_tenure_6_month_v2", name: "Nitro Gold", description: "6 months: Gold", hash: "2895086c18d5531d499862e41d1155a6", link: "https://discord.com/settings/premium" },
            { id: "platinum", discordId: "premium_tenure_12_month_v2", name: "Nitro Platinum", description: "1 year: Platinum", hash: "0334688279c8359120922938dcb1d6f8", link: "https://discord.com/settings/premium" },
            { id: "diamond", discordId: "premium_tenure_24_month_v2", name: "Nitro Diamond", description: "2 years: Diamond", hash: "0d61871f72bb9a33a7ae568c1fb4f20a", link: "https://discord.com/settings/premium" },
            { id: "emerald", discordId: "premium_tenure_36_month_v2", name: "Nitro Emerald", description: "3 years: Emerald", hash: "11e2d339068b55d3a506cff34d3780f3", link: "https://discord.com/settings/premium" },
            { id: "ruby", discordId: "premium_tenure_60_month_v2", name: "Nitro Ruby", description: "5 years: Ruby", hash: "cd5e2cfd9d7f27a8cdcd3e8a8d5dc9f4", link: "https://discord.com/settings/premium" },
            { id: "opal", discordId: "premium_tenure_72_month_v2", name: "Nitro Opal", description: "6+ years: Opal", hash: "5b154df19c53dce2af92c9b61e6be5e2", link: "https://discord.com/settings/premium" },
        ]
    },
    {
        key: "booster",
        label: "Server Booster",
        description: "Shown while you boost a server. Evolves with your longest streak. Stopping resets it.",
        section: "common",
        options: [
            { id: "lvl1", discordId: "guild_booster_lvl1", name: "1 month", description: "Server boosting for 1 month", hash: "51040c70d4f20a921ad6674ff86fc95c", link: "https://discord.com/settings/premium" },
            { id: "lvl2", discordId: "guild_booster_lvl2", name: "2 months", description: "Server boosting for 2 months", hash: "0e4080d1d333bc7ad29ef6528b6f2fb7", link: "https://discord.com/settings/premium" },
            { id: "lvl3", discordId: "guild_booster_lvl3", name: "3 months", description: "Server boosting for 3 months", hash: "72bed924410c304dbe3d00a6e593ff59", link: "https://discord.com/settings/premium" },
            { id: "lvl4", discordId: "guild_booster_lvl4", name: "6 months", description: "Server boosting for 6 months", hash: "df199d2050d3ed4ebf84d64ae83989f8", link: "https://discord.com/settings/premium" },
            { id: "lvl5", discordId: "guild_booster_lvl5", name: "9 months", description: "Server boosting for 9 months", hash: "996b3e870e8a22ce519b3a50e6bdd52f", link: "https://discord.com/settings/premium" },
            { id: "lvl6", discordId: "guild_booster_lvl6", name: "12 months", description: "Server boosting for 12 months", hash: "991c9f39ee33d7537d9f408c3e53141e", link: "https://discord.com/settings/premium" },
            { id: "lvl7", discordId: "guild_booster_lvl7", name: "15 months", description: "Server boosting for 15 months", hash: "cb3ae83c15e970e8f3d410bc62cb8b99", link: "https://discord.com/settings/premium" },
            { id: "lvl8", discordId: "guild_booster_lvl8", name: "18 months", description: "Server boosting for 18 months", hash: "7142225d31238f6387d9f09efaa02759", link: "https://discord.com/settings/premium" },
            { id: "lvl9", discordId: "guild_booster_lvl9", name: "24 months", description: "Server boosting for 24 months", hash: "ec92202290b48d0879b7413d2dde3bab", link: "https://discord.com/settings/premium" },
        ]
    },
    {
        key: "bugHunter",
        label: "Bug Hunter",
        description: "Awarded in the Discord Testers community. Gold is for the highest hunter level. Support Portal reports do not count.",
        section: "rare",
        options: [
            { id: "level1", discordId: "bug_hunter_level_1", name: "Bug Hunter", description: "Discord Bug Hunter", hash: "2717692c7dca7289b35297368a940dd0", link: "https://support.discord.com/hc/en-us/articles/360046057772-Discord-Bugs" },
            { id: "level2", discordId: "bug_hunter_level_2", name: "Golden Bug Hunter", description: "Discord Bug Hunter (Gold)", hash: "848f79194d4be5ff5f81505cbd0ce1e6", link: "https://support.discord.com/hc/en-us/articles/360046057772-Discord-Bugs" },
        ]
    },
    {
        key: "hypeHouse",
        label: "HypeSquad House",
        description: "Earned from the old HypeSquad quiz. The quiz is gone and the badge cannot be removed.",
        section: "legacy",
        options: [
            { id: "bravery", discordId: "hypesquad_house_1", name: "Bravery", description: "HypeSquad Bravery", hash: "8a88d63823d8a71cd5e390baa45efa02", link: "https://discord.com/settings/hypesquad-online" },
            { id: "brilliance", discordId: "hypesquad_house_2", name: "Brilliance", description: "HypeSquad Brilliance", hash: "011940fd013da3f7fb926e4a1cd2e618", link: "https://discord.com/settings/hypesquad-online" },
            { id: "balance", discordId: "hypesquad_house_3", name: "Balance", description: "HypeSquad Balance", hash: "3aa41de486fa12454c3761e8e223442e", link: "https://discord.com/settings/hypesquad-online" },
        ]
    },
    {
        key: "gifting",
        label: "Gifting Badge",
        description: "Experiment. Every Nitro or Shop gift counts. Levels: Patron 1, Champion 2, Luminary 3, Icon 6, Hero 10, Legend 20.",
        section: "experiment",
        options: [
            { id: "patron", discordId: "gifting_patron", name: "Patron", description: "Gifting Patron — 1 gift", hash: "ac305d1b9481f312ce4419e7f8296558" },
            { id: "champion", discordId: "gifting_champion", name: "Champion", description: "Gifting Champion — 2 gifts", hash: "8b7792c4f65953d3ff564f23429cb79e" },
            { id: "luminary", discordId: "gifting_luminary", name: "Luminary", description: "Gifting Luminary — 3 gifts", hash: "3119f5504b2cd09576a323908c7c3517" },
            { id: "icon", discordId: "gifting_icon", name: "Icon", description: "Gifting Icon — 6 gifts", hash: "64f2413c9b9803661322aaad25826b62" },
            { id: "hero", discordId: "gifting_hero", name: "Hero", description: "Gifting Hero — 10 gifts", hash: "77d65b1f210014a11eb1582ee06ab684" },
            { id: "legend", discordId: "gifting_legend", name: "Legend", description: "Gifting Legend — 20 gifts", hash: "7fe346cfc5da1340087d8759a9e7a395" },
        ]
    },
    {
        key: "accountAge",
        label: "Account Age",
        description: "Experiment. Leveled badge for how long the account has existed, from Seed (1 year) to Primordial (10+ years).",
        section: "experiment",
        options: [
            { id: "seed", discordId: "account_age_seed", name: "Seed", description: "Account Age Seed — 1 year", hash: "dda73966211a0c16533f8fcd9f1f27c27a628ef562927270e79df9b9c5e6cb12" },
            { id: "sprout", discordId: "account_age_sprout", name: "Sprout", description: "Account Age Sprout — 2 years", hash: "74e1884f930b0d69986f92aeea77d3ff3d3d00c540f386b63e6ebb382d5e927d" },
            { id: "bud", discordId: "account_age_bud", name: "Bud", description: "Account Age Bud — 3 years", hash: "217dab12dcb72d4c95f2863e9dddd5c42003345a001684ea55a736172f32eea1" },
            { id: "sapling", discordId: "account_age_sapling", name: "Sapling", description: "Account Age Sapling — 4 years", hash: "26b89419a4f562ab31a1a72eac04833aa1026af937f1d53c088ec258df3db84b" },
            { id: "blossom", discordId: "account_age_blossom", name: "Blossom", description: "Account Age Blossom — 5 years", hash: "1db184b6d10a61a37dc30efdc74d587560fac5291c8bb329977e93bb5a312602" },
            { id: "redwood", discordId: "account_age_redwood", name: "Redwood", description: "Account Age Redwood — 6 years", hash: "6b0f2ed5be272942eeabea3a0289027d164c7b1ce6a76166d1c928a57db762c5" },
            { id: "sequoia", discordId: "account_age_sequoia", name: "Sequoia", description: "Account Age Sequoia — 7 years", hash: "c095e3e73591843a22dc979d1fcfe3d6cf6841d1f51387d208d19f8bed01deb7" },
            { id: "bristlecone", discordId: "account_age_bristlecone", name: "Bristlecone", description: "Account Age Bristlecone — 8 years", hash: "867feeff5acd481c80bae557c586718fb5390bbaaa1cbde55fae296a7884e799" },
            { id: "stromatolite", discordId: "account_age_stromatolite", name: "Stromatolite", description: "Account Age Stromatolite — 9 years", hash: "a6f4c487be2aa012f41f1fba40e664f914ede9251f4b967d890ab5c065a29fb7" },
            { id: "primordial", discordId: "account_age_primordial", name: "Primordial", description: "Account Age Primordial — 10+ years", hash: "1d8caace0299b12bcc469c35ce927e838abd9c645a22fe7c556f4394e57fa79b" },
        ]
    },
    {
        key: "streaming",
        label: "Streaming",
        description: "Experiment. Leveled badge for hours streamed to other users, from Newcomer (1 hour) to Phenomenon (5,000+ hours).",
        section: "experiment",
        options: [
            { id: "newcomer", discordId: "streaming_newcomer", name: "Newcomer", description: "Streaming Newcomer — 1 hour", hash: "c56b451e3bf04181182c2529e9bd3659e569ea80f582858090007f0752401b38" },
            { id: "fledgling", discordId: "streaming_fledgling", name: "Fledgling", description: "Streaming Fledgling — 5 hours", hash: "2e25ba794f6f371ea0f52eb2d3c8fb2b04094a56f388515e13a9bd6d7949a018" },
            { id: "breakout", discordId: "streaming_breakout", name: "Breakout", description: "Streaming Breakout — 20 hours", hash: "4e847b4dca20fbf1c56d3a47cac3c9204f02113c9d5a270ebebdf12909c75848" },
            { id: "standout", discordId: "streaming_standout", name: "Standout", description: "Streaming Standout — 75 hours", hash: "27d0e6939f13dcf113243fc9eac642b15e9764ad891e06c5ed78d45a17678582" },
            { id: "trendsetter", discordId: "streaming_trendsetter", name: "Trendsetter", description: "Streaming Trendsetter — 150 hours", hash: "af681483be2035f14b0f2bfe2e25a8944c97149172938888ca1008edbe037aad" },
            { id: "headliner", discordId: "streaming_headliner", name: "Headliner", description: "Streaming Headliner — 300 hours", hash: "e69a0c86a476c9782ea1d3e7b5ba308eec3d9d6a3eae6ab8af3180f67d16b468" },
            { id: "star", discordId: "streaming_star", name: "Star", description: "Streaming Star — 500 hours", hash: "06b6206db966635cf626651bdb94eacce5a23ab05dc7f600f7d31aa482b2058c" },
            { id: "sensation", discordId: "streaming_sensation", name: "Sensation", description: "Streaming Sensation — 1,000 hours", hash: "1a3b9120ecd64c342083c37980b225d29ebf4544da6ab546c9268f87904c9dfe" },
            { id: "visionary", discordId: "streaming_visionary", name: "Visionary", description: "Streaming Visionary — 2,000 hours", hash: "85f714b90ed3ceb1e00e1f2069bf3ebd564962fa940c92540061537a045e54ab" },
            { id: "phenomenon", discordId: "streaming_phenomenon", name: "Phenomenon", description: "Streaming Phenomenon — 5,000+ hours", hash: "61331d04b7a9542b38bfa59583360c0b9b93c6496a04f99c0ab37fa1d83ec58a" },
        ]
    },
    {
        key: "gameTime",
        label: "Game Time",
        description: "Experiment. Play detectable PC games with Discord open. Casual is 1 hour, Eternal is 5,000+ hours.",
        section: "experiment",
        options: [
            { id: "casual", discordId: "game_time_casual", name: "Casual", description: "Game Time Casual — 1 hour", hash: "b75fcc4dd1c65dfd4169a203e21023453fd6fe853c9b5c1fd839781fda98e80d" },
            { id: "recreational", discordId: "game_time_recreational", name: "Recreational", description: "Game Time Recreational — 5 hours", hash: "f0f32cb2a0003475e443b76a7a2baf454356953ecb84195c7a08c3ce2fd95b70" },
            { id: "dedicated", discordId: "game_time_dedicated", name: "Dedicated", description: "Game Time Dedicated — 20 hours", hash: "e0c82f41bcad94a2a52713800fbef7687d0d2c6a6066b09d5e5876156d086e1a" },
            { id: "committed", discordId: "game_time_committed", name: "Committed", description: "Game Time Committed — 75 hours", hash: "16f2aeb7465c99efce4d67d9333e3ddcf7435d6e60d2f5f93dc0c07bc7c5a69b" },
            { id: "serious", discordId: "game_time_serious", name: "Serious", description: "Game Time Serious — 150 hours", hash: "ba26e83fa68189b41837184e38706f41c288dd29ffba266035d1a5ad9adbae22" },
            { id: "devoted", discordId: "game_time_devoted", name: "Devoted", description: "Game Time Devoted — 300 hours", hash: "851b194288f1913ece6c8d99976519e48210580d6f42d994f21e37801611ad54" },
            { id: "seasoned", discordId: "game_time_seasoned", name: "Seasoned", description: "Game Time Seasoned — 500 hours", hash: "8b10f5c0c30abbd521be5afc2e0dd4ec6da18bfbc689f06d93a51d06577cd84a" },
            { id: "ironclad", discordId: "game_time_ironclad", name: "Ironclad", description: "Game Time Ironclad — 1,000 hours", hash: "d705628490898f2cc22d669cf8b415bc03fed1ddaf98a2a8cbd97442a509293c" },
            { id: "unshakeable", discordId: "game_time_unshakeable", name: "Unshakeable", description: "Game Time Unshakeable — 2,000 hours", hash: "2bddcbc9f9959dab805eb7196c8112ce9dc68b09766c8193ab499b1870e44ac7" },
            { id: "eternal", discordId: "game_time_eternal", name: "Eternal", description: "Game Time Eternal — 5,000+ hours", hash: "457ce4e657f0ced23197891cc3d75b7de29cafa065cdb8cbb81060ac0e63b07f" },
        ]
    },
    {
        key: "gameVariety",
        label: "Game Variety",
        description: "Experiment. Play different detectable PC games with Discord open. Sampler is 2 games, Universalist is 100+.",
        section: "experiment",
        options: [
            { id: "sampler", discordId: "game_variety_sampler", name: "Sampler", description: "Game Variety Sampler — 2 games", hash: "ed18d5976c01a4ea19f5a13af08f0547582405cbe48b098b0822e352b8e0a822" },
            { id: "dabbler", discordId: "game_variety_dabbler", name: "Dabbler", description: "Game Variety Dabbler — 5 games", hash: "e450d5279537db06ee47a104af520b884adaa7ffc3ef2627157526bf1c58e840" },
            { id: "enthusiast", discordId: "game_variety_enthusiast", name: "Enthusiast", description: "Game Variety Enthusiast — 10 games", hash: "158a9d91b8ca9e96d4afeee38cd640fc51483a8196edb9af0c26e44727acafae" },
            { id: "ranger", discordId: "game_variety_ranger", name: "Ranger", description: "Game Variety Ranger — 15 games", hash: "9e491942070007f64011ae4fc478926b96433698c07621fc43bafdd5efe83912" },
            { id: "explorer", discordId: "game_variety_explorer", name: "Explorer", description: "Game Variety Explorer — 20 games", hash: "e25fc55814262150e154ddb1a2b55fc5ed8ed5ba2ff1a22a33d4a41e651e370a" },
            { id: "adventurer", discordId: "game_variety_adventurer", name: "Adventurer", description: "Game Variety Adventurer — 30 games", hash: "542d5277e0001ea738d5eb57b247dcab9ce6e0c29493d5892203f6258fde55b9" },
            { id: "voyager", discordId: "game_variety_voyager", name: "Voyager", description: "Game Variety Voyager — 40 games", hash: "082e693cb9ce98b81af618978d449409efc6522b061bc0eac6e88a949fd888c6" },
            { id: "maverick", discordId: "game_variety_maverick", name: "Maverick", description: "Game Variety Maverick — 60 games", hash: "6fc242e9e8259c471a5e4599cd09af5476e622a572ff235883173913bf506103" },
            { id: "polymath", discordId: "game_variety_polymath", name: "Polymath", description: "Game Variety Polymath — 80 games", hash: "be9a4d119b8e0d7fc1df7e5a12081332637cb9c978a90377cb9c930500b2fbe6" },
            { id: "universalist", discordId: "game_variety_universalist", name: "Universalist", description: "Game Variety Universalist — 100+ games", hash: "fcc34d343451505c642f3397cec2669a2de3a4a410fb968f794b3a1a0dcd1728" },
        ]
    },
];

export const TOGGLE_BADGES: ToggleBadge[] = [
    {
        id: "quest",
        discordId: "quest_completed",
        name: "Discord Quests",
        description: "Awarded after completing a Quest. Discord currently cannot remove it.",
        hash: "7d9ae358c8c5e118768335dbe68b4fb8",
        link: "https://discord.com/discovery/quests",
        section: "common"
    },
    {
        id: "orbs",
        discordId: "orb_profile_badge",
        name: "Orbs",
        description: "Purchased from the Orbs shop. Once bought, it cannot be removed.",
        hash: "83d8a1eb09a8d64e59233eec5d4d5c2d",
        section: "common"
    },
    {
        id: "legacyUsername",
        discordId: "legacy_username",
        name: "Legacy Username",
        description: "Kept an old username and discriminator from before the Pomelo change.",
        hash: "6de6d34650760ba5551a79732e98ed60",
        section: "common"
    },
    {
        id: "staff",
        discordId: "staff",
        name: "Discord Staff",
        description: "Mythic badge for people who work at Discord HQ.",
        hash: "5e74e9b61934fc1f67c65515d1f7e60d",
        link: "https://discord.com/company",
        section: "rare"
    },
    {
        id: "hypeEvents",
        discordId: "hypesquad",
        name: "HypeSquad Events",
        description: "Attended a HypeSquad event. No longer obtainable.",
        hash: "bf01d1073931f921909045f3a39fd264",
        link: HELP_ARTICLE,
        section: "legacy"
    },
    {
        id: "moderatorAlumni",
        discordId: "certified_moderator",
        name: "Moderator Program Alumni",
        description: "Former Certified Discord Moderator. Stopped being granted after December 1, 2022.",
        hash: "fee1624003e2fee35cb398e125dc479b",
        link: "https://discord.com/safety",
        section: "legacy"
    },
    {
        id: "earlySupporter",
        discordId: "early_supporter",
        name: "Early Supporter",
        description: "Bought Nitro before October 10, 2018. No longer obtainable.",
        hash: "7060786766c9c840eb3019e725d2b358",
        link: "https://discord.com/settings/premium",
        section: "legacy"
    },
    {
        id: "partner",
        discordId: "partner",
        name: "Partnered Server Owner",
        description: "Owns a Partnered server. No longer obtainable.",
        hash: "3f9748e53446a137a052f3454e2de41e",
        link: "https://discord.com/partners",
        section: "legacy"
    },
    {
        id: "lastMeadow",
        discordId: "april_fools_2026",
        name: "Last Meadow Online",
        description: "Played Last Meadow Online from April 1–7, 2026. Hover shows level progression. No longer obtainable.",
        hash: "ca105ad9cfc8580c765101d17bbb2323",
        section: "legacy"
    },
    {
        id: "verifiedDeveloper",
        discordId: "verified_developer",
        name: "Early Verified Bot Developer",
        description: "Verified a bot in 75+ servers before August 19, 2020. No longer obtainable.",
        hash: "6df5892e0f35b051f8b61eace34f4967",
        section: "unobtainable"
    },
    {
        id: "activeDeveloper",
        discordId: "active_developer",
        name: "Active Developer",
        description: "Had an app that received a command in the last 30 days. This badge no longer exists.",
        hash: "6bdc42827a38498929a4920da12695d9",
        link: "https://support-dev.discord.com/hc/en-us/articles/10113997751447",
        section: "unobtainable"
    },
];

export const SECTIONS: BadgeSection[] = ["common", "rare", "legacy", "experiment", "unobtainable"];

export function findChoiceOption(group: ChoiceGroup, value: string | undefined) {
    if (!value || value === "off") return undefined;
    return group.options.find(option => option.id === value);
}
