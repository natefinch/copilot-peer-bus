import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { SOURCE, Updater, blobSha, installLatest } from "../.github/extensions/peer-bus/update.mjs";

let dir;

beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(os.tmpdir(), "peer-bus-update-")), "peer-bus");
    mkdirSync(dir);
});

afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

// Serves a source commit whose extension folder holds `files` (name -> content).
function fakeSource(files, { corrupt = [] } = {}) {
    const blobs = new Map();
    const tree = [{ path: "README.md", type: "blob", sha: blobSha(Buffer.from("readme")) }];
    for (const [name, content] of Object.entries(files)) {
        const sha = blobSha(Buffer.from(content));
        blobs.set(sha, corrupt.includes(name) ? `${content}!` : content);
        tree.push({ path: `${SOURCE.path}/${name}`, type: "blob", sha });
    }
    const requests = [];
    const github = {
        request: async (method, url) => {
            requests.push(url);
            if (url === `/repos/${SOURCE.repo}/commits/${SOURCE.ref}`) return { sha: "abcdef1234567", commit: { tree: { sha: "t1" }, message: "Fix things\n\nDetails" } };
            if (url === `/repos/${SOURCE.repo}/git/trees/t1?recursive=1`) return { tree, truncated: false };
            const sha = url.split("/").pop();
            return { content: Buffer.from(blobs.get(sha)).toString("base64"), encoding: "base64" };
        },
        raw: async (method, url) => ({ status: 200, data: await github.request(method, url) }),
    };
    return { github, requests };
}

const shas = (files) => new Map(Object.entries(files).map(([name, content]) => [name, blobSha(Buffer.from(content))]));

test("Updater installs and reloads once per new source commit", async () => {
    writeFileSync(path.join(dir, "extension.mjs"), "old");
    const { github, requests } = fakeSource({ "extension.mjs": "new" });
    const reloads = [];
    const updater = new Updater({ github, dir, loaded: shas({ "extension.mjs": "old" }), reload: (result) => reloads.push(result.commit) });

    const result = await updater.update({ periodic: true });
    assert.equal(result.stale, true);
    assert.deepEqual(result.written, ["extension.mjs"]);
    assert.deepEqual(reloads, ["abcdef1234567"]);

    const before = requests.length;
    assert.equal(await updater.update({ periodic: true }), null);
    assert.equal(requests.length, before + 1, "an unchanged commit downloads nothing");
    assert.equal(reloads.length, 1);
});

test("Updater reloads when another session already installed the update, and not when current", async () => {
    writeFileSync(path.join(dir, "extension.mjs"), "new");
    const { github } = fakeSource({ "extension.mjs": "new" });
    const reloads = [];

    const stale = await new Updater({ github, dir, loaded: shas({ "extension.mjs": "old" }), reload: () => reloads.push("stale") }).update();
    assert.deepEqual([stale.stale, stale.written], [true, []]);

    const current = await new Updater({ github, dir, loaded: shas({ "extension.mjs": "new" }), reload: () => reloads.push("current") }).update();
    assert.equal(current.stale, false);
    assert.deepEqual(reloads, ["stale"]);
});

test("installLatest downloads only changed files, including new nested ones", async () => {
    writeFileSync(path.join(dir, "extension.mjs"), "old");
    writeFileSync(path.join(dir, "bus.mjs"), "same");
    const { github, requests } = fakeSource({ "extension.mjs": "new", "bus.mjs": "same", "lib/util.mjs": "util" });

    const result = await installLatest({ github, dir });

    assert.equal(result.commit, "abcdef1234567");
    assert.equal(result.summary, "Fix things");
    assert.deepEqual(result.written.sort(), ["extension.mjs", "lib/util.mjs"]);
    assert.deepEqual(result.files.map((f) => f.name).sort(), ["bus.mjs", "extension.mjs", "lib/util.mjs"]);
    assert.equal(readFileSync(path.join(dir, "extension.mjs"), "utf8"), "new");
    assert.equal(readFileSync(path.join(dir, "lib", "util.mjs"), "utf8"), "util");
    assert.equal(requests.filter((url) => url.includes("/git/blobs/")).length, 2);
});

test("installLatest changes nothing when a download doesn't match its SHA", async () => {
    writeFileSync(path.join(dir, "extension.mjs"), "old");
    writeFileSync(path.join(dir, "bus.mjs"), "old bus");
    const { github } = fakeSource({ "extension.mjs": "new", "bus.mjs": "new bus" }, { corrupt: ["bus.mjs"] });

    await assert.rejects(installLatest({ github, dir }), /bus\.mjs doesn't match its SHA/);
    assert.equal(readFileSync(path.join(dir, "extension.mjs"), "utf8"), "old");
    assert.deepEqual(readdirSync(dir).sort(), ["bus.mjs", "extension.mjs"]);
});
