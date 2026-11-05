// Live smoke test against real GitHub + Alive. Polling is disabled, so delivery must come from Alive pushes.
// Usage: PEER_BUS_LIVE_REPO=owner/private-repo npm run test:live   (uses `gh auth token`)
// Like peer_configure, it stops watching the repository so the test traffic doesn't notify you.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PeerBus } from "../.github/extensions/peer-bus/bus.mjs";
import { GitHub } from "../.github/extensions/peer-bus/github.mjs";
import { SessionStore, sessionHash } from "../.github/extensions/peer-bus/state.mjs";

const repo = process.env.PEER_BUS_LIVE_REPO;
if (!repo) {
    console.error("Set PEER_BUS_LIVE_REPO=owner/private-repo");
    process.exit(2);
}
const home = mkdtempSync(path.join(os.tmpdir(), "peer-bus-live-"));
const run = Date.now().toString(36);
let channelRef = null;

function waitFor(predicate, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const value = predicate();
            if (value) return resolve(value);
            if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
            setTimeout(tick, 5);
        };
        tick();
    });
}

function session(name) {
    const prompts = [];
    const github = new GitHub({ repo });
    const bus = new PeerBus({
        github,
        store: new SessionStore(`live-${name}-${run}`, { COPILOT_HOME: home }),
        sid: sessionHash(`live-${name}-${run}`),
        host: os.hostname(),
        platform: process.platform,
        deliver: (prompt) => prompts.push({ prompt, at: Date.now() }),
        notify: (text) => console.log(`  [${name} notify] ${text}`),
        log: (text) => console.log(`  [${name}] ${text}`),
        pollMs: 1e9,
        fallbackPollMs: 1e9,
    });
    return { name: `live-${name}-${run}`, bus, prompts, github };
}

const a = session("a");
const b = session("b");
try {
    await a.github.unwatchRepo();
    await a.bus.join({ name: a.name });
    await b.bus.join({ name: b.name });
    await waitFor(() => a.bus.alive.live && b.bus.alive.live);
    console.log("both sessions joined; Alive live");

    const login = a.bus.me.login;
    let sentAt = Date.now();
    await a.bus.send({ to: `${login}/${b.name}`, message: "live direct message" });
    const sendMs = Date.now() - sentAt;
    await waitFor(() => b.prompts.length === 1);
    console.log(`direct: send call ${sendMs}ms, delivered ${b.prompts[0].at - sentAt}ms after send started`);
    assert.match(b.prompts[0].prompt, /live direct message/);

    const created = await a.bus.createChannel({ title: `peer-bus live test ${run}` });
    channelRef = { repo: created.repo, number: created.number };
    await b.bus.joinChannel(created.html_url);
    await waitFor(() => a.bus.alive.live && b.bus.alive.live);
    sentAt = Date.now();
    await b.bus.send({ to: "*", channel: created.html_url, message: "live channel broadcast" });
    await waitFor(() => a.prompts.length === 1);
    console.log(`channel (joined by URL): delivered ${a.prompts[0].at - sentAt}ms after send started`);
    assert.match(a.prompts[0].prompt, /peer-bus live test/);

    const { sessions } = await a.bus.list({ channel: created.html_url });
    assert.deepEqual(sessions.map((s) => s.session).sort(), [a.name, b.name].sort());
    console.log("PASS");
} finally {
    await a.bus.leave().catch(() => {});
    await b.bus.leave().catch(() => {});
    if (channelRef) await a.github.closeIssue(channelRef).catch(() => {});
    a.bus.stop();
    b.bus.stop();
    rmSync(home, { recursive: true, force: true });
}
process.exit(0);
