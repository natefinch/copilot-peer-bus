// Self-update: installs the latest copy of this extension from its source repository over the running copy.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const SOURCE = { repo: "natefinch/copilot-peer-bus", ref: "main", path: ".github/extensions/peer-bus" };
export const SOURCE_URL = `https://github.com/${SOURCE.repo}`;

// The SHA git gives a file's content, which GitHub's tree API reports for each file.
export function blobSha(content) {
    return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

// Maps each file under dir (relative path, / separators) to its git blob SHA.
export async function fileShas(dir) {
    const shas = new Map();
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(entry.parentPath, entry.name);
        shas.set(path.relative(dir, full).split(path.sep).join("/"), blobSha(await readFile(full)));
    }
    return shas;
}

// A copy in a repository's .github/extensions folder, which git manages.
export function isProjectCopy(dir) {
    return path.basename(path.dirname(path.dirname(dir))) === ".github";
}

function refuseProjectCopy(dir) {
    if (isProjectCopy(dir)) {
        throw new Error(`This copy of peer-bus is a project extension in ${path.resolve(dir, "../../..")}; update it with git instead.`);
    }
}

// Downloads the files that differ from source and writes them into dir. Returns the source commit, every
// source file with its SHA, and the names of the files written. Files that no longer exist in source are left.
// Pass commit (from the commits API) to skip fetching it.
export async function installLatest({ github, dir, source = SOURCE, commit }) {
    refuseProjectCopy(dir);
    commit ??= await github.request("GET", `/repos/${source.repo}/commits/${source.ref}`);
    const tree = await github.request("GET", `/repos/${source.repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error(`GitHub truncated the file list of ${source.repo}; can't update.`);
    const prefix = `${source.path}/`;
    const files = tree.tree
        .filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix))
        .map((entry) => ({ name: entry.path.slice(prefix.length), sha: entry.sha }));
    if (!files.some((file) => file.name === "extension.mjs")) {
        throw new Error(`${source.repo} has no extension in ${source.path} on ${source.ref}.`);
    }

    const local = await fileShas(dir);
    const downloads = await Promise.all(
        files
            .filter((file) => local.get(file.name) !== file.sha)
            .map(async (file) => {
                const blob = await github.request("GET", `/repos/${source.repo}/git/blobs/${file.sha}`);
                const content = Buffer.from(blob.content, blob.encoding);
                if (blobSha(content) !== file.sha) throw new Error(`Downloaded ${file.name} doesn't match its SHA; nothing was changed.`);
                return { ...file, content };
            }),
    );
    // Stage every file before replacing any, so a failed write leaves the old copy whole. The suffix is per
    // process because sessions sharing an install can update it at the same time.
    const suffix = `.update-${process.pid}`;
    for (const file of downloads) {
        const target = path.join(dir, file.name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(`${target}${suffix}`, file.content);
    }
    for (const file of downloads) {
        const target = path.join(dir, file.name);
        await rename(`${target}${suffix}`, target);
    }
    return { commit: commit.sha, summary: commit.commit.message.split("\n")[0], files, written: downloads.map((file) => file.name) };
}

// Installs the latest source and calls reload() when the running code (loaded: the SHAs fileShas returned when
// the extension started) differs from it, whether this update or another session's installed the new files.
export class Updater {
    constructor({ github, dir, loaded, reload, source = SOURCE }) {
        Object.assign(this, { github, dir, loaded, reload, source });
        this.checked = null; // source commit already installed and compared
        this.timer = null;
    }

    // Returns the installLatest result plus stale (whether it reloads). With periodic, returns null without
    // downloading anything when the source commit hasn't changed since the last update; the commit lookup
    // uses an ETag, so an unchanged answer doesn't count against the rate limit.
    async update({ periodic = false } = {}) {
        refuseProjectCopy(this.dir);
        const { data: commit } = await this.github.raw("GET", `/repos/${this.source.repo}/commits/${this.source.ref}`, { conditional: periodic });
        if (periodic && commit.sha === this.checked) return null;
        const result = await installLatest({ github: this.github, dir: this.dir, source: this.source, commit });
        this.checked = commit.sha;
        const stale = result.files.some((file) => this.loaded.get(file.name) !== file.sha);
        if (stale) this.reload(result);
        return { ...result, stale };
    }

    // Checks now and then every intervalMs. onError receives failures, which are retried at the next check.
    start(intervalMs, onError) {
        const check = () => this.update({ periodic: true }).catch(onError);
        check();
        this.timer = setInterval(check, intervalMs);
        this.timer.unref?.();
    }

    stop() {
        clearInterval(this.timer);
    }
}
