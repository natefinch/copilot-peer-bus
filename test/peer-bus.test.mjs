import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
    PeerBusClient,
    clearJoinedName,
    createSseParser,
    formatIncoming,
    loadConfig,
    loadJoinedName,
    saveConfig,
    saveJoinedName,
} from "../.github/extensions/peer-bus/client.mjs";
import { createRelay } from "../relay/server.mjs";

const TOKEN = "test-token";

async function startRelay(options = {}) {
    const server = createRelay({ token: TOKEN, heartbeatMs: 50, ...options });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function waitFor(predicate, timeoutMs = 2000) {
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

function makeClient(url, name, extra = {}) {
    const received = [];
    const states = [];
    const client = new PeerBusClient({
        url,
        token: TOKEN,
        name,
        host: `${name}-host`,
        platform: "testos",
        onMessage: (message) => received.push(message),
        onStatus: (state) => states.push(state),
        reconnectMinMs: 20,
        reconnectMaxMs: 50,
        ...extra,
    });
    return { client, received, states };
}

describe("relay + client", () => {
    let relay;
    const clients = [];

    beforeEach(async () => {
        relay = await startRelay();
    });

    afterEach(async () => {
        await Promise.all(clients.splice(0).map((c) => c.stop()));
        await new Promise((resolve) => relay.server.close(resolve));
    });

    async function connected(name, extra) {
        const peer = makeClient(relay.url, name, extra);
        clients.push(peer.client);
        peer.client.start();
        await waitFor(() => peer.client.state === "connected");
        return peer;
    }

    test("delivers a direct message to the named peer only", async () => {
        const a = await connected("mac");
        const b = await connected("windows");
        const c = await connected("linux");

        const result = await a.client.send("windows", "run the tests");
        assert.deepEqual(result.delivered, ["windows"]);
        await waitFor(() => b.received.length === 1);
        assert.equal(b.received[0].from, "mac");
        assert.equal(b.received[0].body, "run the tests");
        assert.equal(c.received.length, 0);
        assert.equal(a.received.length, 0);
    });

    test("broadcast reaches every peer except the sender", async () => {
        const a = await connected("mac");
        const b = await connected("windows");
        const c = await connected("linux");

        const result = await a.client.send("*", "hello all");
        assert.deepEqual(result.delivered.sort(), ["linux", "windows"]);
        await waitFor(() => b.received.length === 1 && c.received.length === 1);
        assert.equal(a.received.length, 0);
    });

    test("queues messages for an offline peer and flushes them on connect", async () => {
        const a = await connected("mac");
        const result = await a.client.send("windows", "queued work");
        assert.deepEqual(result.queued, ["windows"]);

        const b = await connected("windows");
        await waitFor(() => b.received.length === 1);
        assert.equal(b.received[0].body, "queued work");
    });

    test("lists peers with host and platform", async () => {
        const a = await connected("mac");
        await connected("windows");
        const peers = await a.client.peers();
        assert.deepEqual(
            peers.map(({ name, host, platform }) => ({ name, host, platform })),
            [
                { name: "mac", host: "mac-host", platform: "testos" },
                { name: "windows", host: "windows-host", platform: "testos" },
            ]
        );
    });

    test("a second connection with the same name replaces the first, which stops reconnecting", async () => {
        const first = await connected("windows");
        const second = await connected("windows");
        await waitFor(() => first.client.state === "replaced");
        const sender = await connected("mac");
        await sender.client.send("windows", "who gets this");
        await waitFor(() => second.received.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(first.received.length, 0);
        assert.equal(second.client.state, "connected");
    });

    test("rejects requests without the token", async () => {
        const { client, states } = makeClient(relay.url, "intruder", { token: "wrong" });
        await client.start();
        assert.equal(client.state, "unauthorized");
        assert.ok(states.includes("unauthorized"));
        await assert.rejects(client.send("mac", "hi"), /unauthorized/);
    });

    test("reconnects after the relay restarts on the same port", async () => {
        const port = relay.server.address().port;
        const b = await connected("windows");
        await new Promise((resolve) => relay.server.close(resolve));
        await waitFor(() => b.client.state === "disconnected");

        relay = { server: createRelay({ token: TOKEN }), url: relay.url };
        await new Promise((resolve) => relay.server.listen(port, "127.0.0.1", resolve));
        await waitFor(() => b.client.state === "connected");

        const a = await connected("mac");
        await a.client.send("windows", "after restart");
        await waitFor(() => b.received.length === 1);
    });

    test("validates send payloads", async () => {
        const a = await connected("mac");
        await assert.rejects(a.client.send("bad name!", "x"), /invalid to/);
        await assert.rejects(a.client.send("windows", ""), /body is required/);
    });
});

describe("SSE parser", () => {
    test("handles chunks split mid-line, CRLF, comments and multi-line data", () => {
        const events = [];
        const feed = createSseParser((e) => events.push(e));
        const stream = ": ping\r\nevent: message\r\nid: 1\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\nretry: 5\n\nevent: ready\ndata: x\n\n";
        for (const char of stream) feed(char);
        assert.deepEqual(events, [
            { event: "message", data: '{"a":\n1}', id: "1" },
            { event: "ready", data: "x", id: "" },
        ]);
    });
});

describe("config and session state", () => {
    let home;
    beforeEach(() => {
        home = mkdtempSync(path.join(os.tmpdir(), "peer-bus-"));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    test("env overrides config.json, trailing slash trimmed", () => {
        const env = { COPILOT_HOME: home };
        mkdirSync(path.join(home, "peer-bus"));
        writeFileSync(path.join(home, "peer-bus", "config.json"), JSON.stringify({ url: "http://a:1/", token: "t" }));
        assert.deepEqual(loadConfig(env), { url: "http://a:1", token: "t" });
        assert.deepEqual(loadConfig({ ...env, PEER_BUS_URL: "http://b:2" }), { url: "http://b:2", token: "t" });
    });

    test("saveConfig writes a private config that loadConfig reads back", () => {
        const env = { COPILOT_HOME: home };
        saveConfig({ url: "http://relay:7777/", token: "secret" }, env);
        assert.deepEqual(loadConfig(env), { url: "http://relay:7777", token: "secret" });
        if (process.platform !== "win32") {
            assert.equal(statSync(path.join(home, "peer-bus", "config.json")).mode & 0o777, 0o600);
        }
        assert.throws(() => saveConfig({ url: "not a url", token: "x" }, env), /Invalid relay URL/);
    });

    test("loadConfig tolerates a UTF-8 byte-order mark", () => {
        const env = { COPILOT_HOME: home };
        mkdirSync(path.join(home, "peer-bus"));
        writeFileSync(path.join(home, "peer-bus", "config.json"), `\uFEFF${JSON.stringify({ url: "http://a:1", token: "t" })}`);
        assert.deepEqual(loadConfig(env), { url: "http://a:1", token: "t" });
    });

    test("joined name round-trips and clears", () => {
        const env = { COPILOT_HOME: home };
        assert.equal(loadJoinedName("s/1", env), null);
        saveJoinedName("s/1", "windows-tester", env);
        assert.equal(loadJoinedName("s/1", env), "windows-tester");
        clearJoinedName("s/1", env);
        assert.equal(loadJoinedName("s/1", env), null);
    });

    test("formatIncoming tells the agent how to reply", () => {
        const text = formatIncoming({ id: "1", from: "mac", to: "windows", body: "hi", sentAt: "now" }, "windows");
        assert.match(text, /<peer_message from="mac"/);
        assert.match(text, /peer_send with to="mac"/);
    });
});
