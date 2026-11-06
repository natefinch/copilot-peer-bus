import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import { createFakeGitHub } from "./fixtures/fake-github.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let fake;
let home;
const children = [];

beforeEach(async () => {
    fake = createFakeGitHub();
    await fake.listen();
    home = mkdtempSync(path.join(os.tmpdir(), "peer-bus-ext-"));
});

afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    await fake.close();
    rmSync(home, { recursive: true, force: true });
});

function waitFor(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const value = predicate();
            if (value) return resolve(value);
            if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for condition"));
            setTimeout(tick, 10);
        };
        tick();
    });
}

async function launchExtension(sessionId, login) {
    const { PEER_BUS_GITHUB_TOKEN: _t, ...baseEnv } = process.env;
    const child = fork(path.join(root, ".github", "extensions", "peer-bus", "extension.mjs"), {
        execArgv: ["--import", path.join(root, "test", "fixtures", "register-fake-sdk.mjs")],
        env: {
            ...baseEnv,
            SESSION_ID: sessionId,
            COPILOT_HOME: home,
            PEER_BUS_API_URL: fake.url,
            PEER_BUS_GITHUB_TOKEN: `tok-${login}`,
            PEER_BUS_ALIVE: "0",
            PEER_BUS_FALLBACK_POLL_MS: "100",
        },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    children.push(child);
    const events = [];
    const pending = new Map();
    let nextCall = 0;
    child.on("message", (message) => {
        if (message.type === "result") {
            const { resolve, reject } = pending.get(message.callId);
            pending.delete(message.callId);
            if (message.error) reject(new Error(message.error));
            else resolve(message.result);
        } else {
            events.push(message);
        }
    });
    await waitFor(() => events.some((e) => e.type === "joined"));
    const call = (tool, args = {}) =>
        new Promise((resolve, reject) => {
            const callId = nextCall++;
            pending.set(callId, { resolve, reject });
            child.send({ callId, tool, args });
        });
    const prompts = () => events.filter((e) => e.type === "prompt").map((e) => e.prompt);
    return { child, call, prompts, events };
}

test("extension: join, create a channel, message by URL, reply, and rejoin after restart", async () => {
    const mac = await launchExtension("session-mac", "natefinch");
    const win = await launchExtension("session-win", "natefinch");
    assert.deepEqual(mac.events.find((e) => e.type === "joined").tools, [
        "peer_join",
        "peer_leave",
        "peer_channel_join",
        "peer_channel_create",
        "peer_channel_leave",
        "peer_list",
        "peer_send",
        "peer_trust",
    ]);

    await assert.rejects(mac.call("peer_channel_join", { channel: "acme/channels#1" }), /Call peer_join/);
    assert.match(await mac.call("peer_join", { name: "mac" }), /Joined the peer bus as natefinch\/mac/);
    await win.call("peer_join", { name: "win" });

    const created = await mac.call("peer_channel_create", { title: "Windows smoke tests", repo: "acme/channels", about: "acme/channels#99" });
    const url = /Share this URL so other sessions can join: (\S+)$/.exec(created)[1];
    await assert.rejects(win.call("peer_channel_join", { channel: "release" }), /Invalid channel/);
    assert.match(await win.call("peer_channel_join", { channel: url }), /^Joined "Windows smoke tests" \(https:\/\/github\.com\/acme\/channels\/issues\/1\)\.$/);

    const list = await mac.call("peer_list");
    assert.match(list, /This session: natefinch\/mac · push polling/);
    assert.match(list, /- natefinch\/mac \(this session\): \S+ \(\w+\)/);
    assert.match(list, /- natefinch\/win: /);

    const sent = await mac.call("peer_send", { channel: url, to: "natefinch/win", message: "please run the test suite" });
    const [, id, commentUrl] = /^Sent (m-[a-z0-9]{8}): (\S+)$/.exec(sent);
    await waitFor(() => win.prompts().length === 1);
    assert.match(win.prompts()[0], new RegExp(`id="${id}" comment="${commentUrl}" from="natefinch/mac" to="natefinch/win"[\\s\\S]*please run the test suite`));
    await waitFor(() => fake.reactions.some((r) => r.content === "eyes"));

    await win.call("peer_send", { channel: url, to: "natefinch/mac", message: "done, all green", reply_to: id });
    await waitFor(() => mac.prompts().length === 1);
    assert.match(mac.prompts()[0], new RegExp(`re="${id}"`));

    win.child.kill();
    await new Promise((resolve) => win.child.once("exit", resolve));
    await mac.call("peer_send", { channel: url, to: "natefinch/win", message: "sent while you were away" });
    const winAgain = await launchExtension("session-win", "natefinch");
    await waitFor(() => winAgain.prompts().length === 1);
    assert.match(winAgain.prompts()[0], /sent while you were away/);

    assert.match(await winAgain.call("peer_leave"), /Left the peer bus \(was natefinch\/win\)/);
    assert.doesNotMatch(await mac.call("peer_list"), /natefinch\/win/);
});
