import { copyFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const files = [
    "package.json",
    "patcher.js",
    "patcher.js.map",
    "patcher.js.LEGAL.txt",
    "preload.js",
    "preload.js.map",
    "renderer.js",
    "renderer.js.map",
    "renderer.css",
    "renderer.css.map",
    "renderer.js.LEGAL.txt",
    "vencordDesktopMain.js",
    "vencordDesktopMain.js.map",
    "vencordDesktopMain.js.LEGAL.txt",
    "vencordDesktopPreload.js",
    "vencordDesktopPreload.js.map",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.js.map",
    "vencordDesktopRenderer.css",
    "vencordDesktopRenderer.css.map",
    "vencordDesktopRenderer.js.LEGAL.txt"
];

const repoDist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const appData = process.env.APPDATA;
if (!appData) {
    console.log("APPDATA is not set; skipped Discord dist copy.");
    process.exit(0);
}

const dests = [join(appData, "Vencord", "dist")];
const localAppData = process.env.LOCALAPPDATA;
if (localAppData) {
    dests.push(join(localAppData, "DelexooVencord", "Vencord", "dist"));
}

let copied = 0;
for (const destDist of dests) {
    mkdirSync(destDist, { recursive: true });
    for (const name of files) {
        const from = join(repoDist, name);
        if (!existsSync(from)) continue;
        copyFileSync(from, join(destDist, name));
        copied += 1;
    }
    console.log(`Copied build files to ${destDist}`);
}

if (copied === 0) {
    console.log("No dist files were copied.");
}
