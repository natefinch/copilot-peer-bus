import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import { createRelay } from "../relay/server.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = "e2e-token";

let relay;
let url;
let home;
const children = [];

beforeEach(async () => {
    relay = createRelay({ token: TOKEN });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${relay.address().port}`;
    home = mkdtempSync(path.join(os.tmpdir(), "peer-bus-ext-"));
});

afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    await new Promise((resolve) => relay.close(resolve));
    rmSync(home, { recursive: true, force: true });
});

function waitFor(predicate, timeoutMs = 3000) {
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

function cleanEnv() {
    const { PEER_BUS_URL: _url, PEER_BUS_TOKEN: _token, ...env } = process.env;
    return env;
}

async function launchExtension(sessionId) {
    const child = fork(path.join(root, ".github", "extensions", "peer-bus", "extension.mjs"), {
        execArgv: ["--import", path.join(root, "test", "fixtures", "register-fake-sdk.mjs")],
        env: { ...cleanEnv(), SESSION_ID: sessionId, COPILOT_HOME: home },
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
    const call = (tool, args) =>
        new Promise((resolve, reject) => {
            const callId = nextCall++;
            pending.set(callId, { resolve, reject });
            child.send({ callId, tool, args });
        });
    const prompts = () => events.filter((e) => e.type === "prompt").map((e) => e.prompt);
    const logs = () => events.filter((e) => e.type === "log").map((e) => e.message);
    return { child, call, prompts, logs, events };
}

test("two extension instances exchange messages, and a session rejoins after restart", async () => {
    const mac = await launchExtension("session-mac");
    const win = await launchExtension("session-win");
    assert.deepEqual(mac.events.find((e) => e.type === "joined").tools, [
        "peer_configure",
        "peer_join",
        "peer_leave",
        "peer_list",
        "peer_send",
    ]);

    await assert.rejects(mac.call("peer_send", { to: "win", message: "x" }), /not joined/);
    await assert.rejects(mac.call("peer_join", { name: "mac" }), /peer_configure/);
    await assert.rejects(mac.call("peer_configure", { url: "ftp://x", token: TOKEN }), /http or https/);
    // Configuration is per machine, so configuring in one session applies to the other session too.
    assert.match(await mac.call("peer_configure", { url, token: TOKEN }), /relay is reachable/);
    await mac.call("peer_join", { name: "mac" });
    await win.call("peer_join", { name: "win" });
    await waitFor(() => win.logs().some((line) => line.includes('connected as "win"')));

    const list = await mac.call("peer_list", {});
    assert.match(list, /- mac \(this session\)/);
    assert.match(list, /- win: host=/);

    assert.match(await mac.call("peer_send", { to: "win", message: "please run the test suite" }), /Delivered to win/);
    await waitFor(() => win.prompts().length === 1);
    assert.match(win.prompts()[0], /<peer_message from="mac" to="win"/);
    assert.match(win.prompts()[0], /please run the test suite/);

    // Simulate an app restart / CLI reload: the extension process exits and a new one starts for the same session.
    win.child.kill();
    await new Promise((resolve) => win.child.once("exit", resolve));
    assert.match(await mac.call("peer_send", { to: "win", message: "sent while offline" }), /queued/);

    const winAgain = await launchExtension("session-win");
    await waitFor(() => winAgain.prompts().length === 1);
    assert.match(winAgain.prompts()[0], /sent while offline/);

    assert.match(await winAgain.call("peer_leave", {}), /Left the peer bus/);
    const afterLeave = await mac.call("peer_list", {});
    assert.doesNotMatch(afterLeave, /- win/);
});
