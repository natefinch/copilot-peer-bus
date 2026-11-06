// Live smoke test against real GitHub + Alive. Polling is disabled, so delivery must come from Alive pushes.
// Usage: PEER_BUS_LIVE_REPO=owner/repo npm run test:live   (uses `gh auth token`; needs the notifications scope)
// Creates a channel issue in that repository and closes it at the end.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PeerBus } from "../.github/extensions/peer-bus/bus.mjs";
import { GitHub } from "../.github/extensions/peer-bus/github.mjs";
import { SessionStore } from "../.github/extensions/peer-bus/state.mjs";

const repo = process.env.PEER_BUS_LIVE_REPO;
if (!repo) {
    console.error("Set PEER_BUS_LIVE_REPO=owner/repo");
    process.exit(2);
}
const home = mkdtempSync(path.join(os.tmpdir(), "peer-bus-live-"));
const run = Date.now().toString(36);

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
    const github = new GitHub();
    const bus = new PeerBus({
        github,
        store: new SessionStore(`live-${name}-${run}`, { COPILOT_HOME: home }),
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
let channel = null;
try {
    await a.bus.join({ name: a.name });
    await b.bus.join({ name: b.name });
    channel = await a.bus.createChannel({ title: `peer-bus live test ${run}`, repo });
    await b.bus.joinChannel(channel.html_url);
    await waitFor(() => a.bus.alive.live && b.bus.alive.live);
    console.log(`channel ${channel.html_url}; Alive live`);

    const login = a.bus.me.login;
    let sentAt = Date.now();
    const question = await a.bus.send({ channel: channel.html_url, to: `${login}/${b.name}`, message: "live message" });
    await waitFor(() => b.prompts.length === 1);
    console.log(`message: delivered ${b.prompts[0].at - sentAt}ms after send started`);
    assert.match(b.prompts[0].prompt, new RegExp(`id="${question.id}"`));

    const commentId = Number(question.url.split("#issuecomment-")[1]);
    let eyes = [];
    for (let i = 0; i < 40 && eyes.length === 0; i++) {
        eyes = (await a.github.request("GET", `/repos/${channel.repo}/issues/comments/${commentId}/reactions?content=eyes`)) ?? [];
        if (eyes.length === 0) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(eyes.length, 1, "recipient marked the message read with 👀");
    console.log("read receipt: 👀 present");

    sentAt = Date.now();
    await b.bus.send({ channel: channel.html_url, to: `${login}/${a.name}`, message: "live reply", replyTo: question.id });
    await waitFor(() => a.prompts.length === 1);
    console.log(`reply: delivered ${a.prompts[0].at - sentAt}ms after send started`);
    assert.match(a.prompts[0].prompt, new RegExp(`re="${question.id}"`));

    const [listed] = await a.bus.list({ channel: channel.html_url });
    assert.deepEqual(listed.sessions.map((s) => s.address).sort(), [`${login}/${a.name}`, `${login}/${b.name}`].sort());
    console.log("PASS");
} finally {
    await a.bus.leave().catch(() => {});
    await b.bus.leave().catch(() => {});
    if (channel) await a.github.closeIssue(channel).catch(() => {});
    a.bus.stop();
    b.bus.stop();
    rmSync(home, { recursive: true, force: true });
}
process.exit(0);
