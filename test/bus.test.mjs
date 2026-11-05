import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { PeerBus } from "../.github/extensions/peer-bus/bus.mjs";
import { GitHub } from "../.github/extensions/peer-bus/github.mjs";
import { issueKey } from "../.github/extensions/peer-bus/protocol.mjs";
import { SessionStore, sessionHash } from "../.github/extensions/peer-bus/state.mjs";
import { FakeAlive, createFakeGitHub } from "./fixtures/fake-github.mjs";

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

let fake;
let home;
let sessions;

beforeEach(async () => {
    fake = createFakeGitHub();
    await fake.listen();
    home = mkdtempSync(path.join(os.tmpdir(), "peer-bus-test-"));
    sessions = [];
});

afterEach(async () => {
    for (const s of sessions) s.bus.stop();
    await fake.close();
    rmSync(home, { recursive: true, force: true });
});

function makeSession(login, sessionId, options = {}) {
    const prompts = [];
    const notes = [];
    const bus = new PeerBus({
        github: new GitHub({ repo: fake.repo, tokenProvider: async () => `tok-${login}`, apiUrl: fake.url }),
        store: new SessionStore(sessionId, { COPILOT_HOME: home }),
        sid: sessionHash(sessionId),
        host: `${login}-host`,
        platform: "testos",
        deliver: (prompt) => prompts.push(prompt),
        notify: (text) => notes.push(text),
        createAlive: (o) => new FakeAlive(fake, o),
        pollMs: 1e9,
        fallbackPollMs: 1e9,
        ...options,
    });
    const handle = { bus, prompts, notes };
    sessions.push(handle);
    return handle;
}

async function joined(login, name, sessionId = `${login}-${name}`, joinOptions = {}, options = {}) {
    const handle = makeSession(login, sessionId, options);
    await handle.bus.join({ name, ...joinOptions });
    return handle;
}

describe("direct messages", () => {
    test("reach only the addressed session, as a prompt from yourself", async () => {
        const mac = await joined("natefinch", "mac");
        const win = await joined("natefinch", "win");
        const linux = await joined("natefinch", "linux");

        await mac.bus.send({ to: "natefinch/win", message: "run the windows tests" });
        await waitFor(() => win.prompts.length === 1);
        await settle();
        assert.match(win.prompts[0], /<peer_message where="direct" from="natefinch\/mac" to="natefinch\/win"/);
        assert.match(win.prompts[0], /run the windows tests/);
        assert.match(win.prompts[0], /peer_send with to="natefinch\/mac"/);
        assert.equal(linux.prompts.length + mac.prompts.length + win.notes.length, 0);

        const inboxes = fake.issues.filter((i) => i.title === "[peer-bus] inbox: @natefinch");
        assert.equal(inboxes.length, 1, "sessions joining back to back share one inbox");
        assert.equal(inboxes[0].author, "natefinch");
        assert.ok(fake.unsubscribed.some((u) => u.id === `I_acme/bus_${inboxes[0].number}`), "unsubscribes from the inbox thread");
        assert.equal(mac.bus.notificationHint(), null);
    });

    test("person address goes to default sessions and @mentions the person", async () => {
        const main = await joined("alice", "main", undefined, { isDefault: true });
        const side = await joined("alice", "side");
        const nate = await joined("natefinch", "mac");
        await nate.bus.trust("alice", true);
        await main.bus.trust("natefinch", true);

        const result = await nate.bus.send({ to: "alice", message: "can you look at the flaky test?" });
        assert.deepEqual(result.notes, []);
        await waitFor(() => main.prompts.length === 1);
        await settle();
        assert.equal(side.prompts.length + side.notes.length, 0);
        assert.match(fake.comments.at(-1).body, /→ @alice/);
    });

    test("untrusted tasks become notifications until trusted; notify kind never prompts", async () => {
        const alice = await joined("alice", "build");
        const nate = await joined("natefinch", "mac");

        await nate.bus.send({ to: "alice/build", message: "please deploy" });
        await waitFor(() => alice.notes.length === 1);
        assert.equal(alice.prompts.length, 0);
        assert.match(alice.notes[0], /natefinch\/mac \(direct\): please deploy .*not given to the agent: natefinch isn't trusted/);

        alice.bus.trust("natefinch", true);
        await nate.bus.send({ to: "alice/build", message: "please deploy now" });
        await waitFor(() => alice.prompts.length === 1);
        await nate.bus.send({ to: "alice/build", message: "fyi: deployed", kind: "notify" });
        await waitFor(() => alice.notes.length === 2);
        assert.doesNotMatch(alice.notes[1], /not given to the agent/);
        assert.equal(alice.prompts.length, 1);
    });

    test("reports offline recipients and validates addresses", async () => {
        const nate = await joined("natefinch", "mac");
        await joined("alice", "build");
        const result = await nate.bus.send({ to: "alice/ghost", message: "hi" });
        assert.deepEqual(result.notes, ["alice/ghost isn't online; it will get the message when it reconnects."]);
        const person = await nate.bus.send({ to: "alice", message: "hi", kind: "notify" });
        assert.match(person.notes[0], /alice has no default session online/);
        await assert.rejects(nate.bus.send({ to: "*", message: "x" }), /needs a channel/);
        await assert.rejects(nate.bus.send({ to: "alice, bob", message: "x" }), /one person's inbox/);
        await assert.rejects(nate.bus.send({ to: "natefinch/mac", message: "x" }), /itself/);
        await assert.rejects(nate.bus.send({ to: "bob", message: "x" }), /bob hasn't joined/);
        await assert.rejects(nate.bus.send({ to: "alice/build", message: "x", channel: "nope" }), /doesn't exist/);
    });

    test("a lookalike inbox created by someone else is ignored", async () => {
        fake.addIssue("bob", "[peer-bus] inbox: @alice", "gotcha");
        const alice = await joined("alice", "build", undefined, {}, {});
        alice.bus.trust("natefinch", true);
        const nate = await joined("natefinch", "mac");
        const { url } = await nate.bus.send({ to: "alice/build", message: "secret" });
        const real = fake.issues.find((i) => i.author === "alice" && i.title === "[peer-bus] inbox: @alice");
        assert.match(url, new RegExp(`/issues/${real.number}#`));
        await waitFor(() => alice.prompts.length === 1);
    });
});

describe("channels", () => {
    test("broadcast reaches channel members except the sender; human comments count as messages", async () => {
        const mac = await joined("natefinch", "mac");
        const win = await joined("natefinch", "win");
        const alice = await joined("alice", "build");
        const outsider = await joined("natefinch", "outsider");
        for (const s of [mac, win, alice]) await s.bus.joinChannel("release");
        assert.equal(fake.issues.filter((i) => i.title === "[peer-bus] channel: release").length, 1);

        await mac.bus.send({ to: "*", channel: "release", message: "cutting the release" });
        await waitFor(() => win.prompts.length === 1 && alice.notes.length === 1);
        await settle();
        const channelIssue = fake.issues.find((i) => i.title === "[peer-bus] channel: release");
        assert.match(win.prompts[0], new RegExp(`where="#release \\(acme/bus#${channelIssue.number}\\)"`));
        assert.match(win.prompts[0], new RegExp(`peer_send with channel="acme/bus#${channelIssue.number}" and to="natefinch/mac"`));
        assert.equal(mac.prompts.length + outsider.prompts.length + outsider.notes.length + alice.prompts.length, 0);

        const channel = fake.issues.find((i) => i.title === "[peer-bus] channel: release");
        fake.addComment("natefinch", channel.number, "humans can talk here too");
        await waitFor(() => mac.prompts.length === 1 && win.prompts.length === 2 && alice.notes.length === 2);
        assert.match(mac.prompts[0], /from="natefinch" to="\*"/);

        await alice.bus.leaveChannel("release");
        await mac.bus.send({ to: "*", channel: "release", message: "after alice left" });
        await waitFor(() => win.prompts.length === 3);
        await settle();
        assert.equal(alice.notes.length, 2);
    });

    test("any issue can be a channel: join by URL, send by key, leave by ref", async () => {
        await fake.close();
        fake = createFakeGitHub({ repos: { "Acme/App": {} } });
        await fake.listen();
        const work = fake.addIssue("alice", "Windows smoke tests for 1.4", "", "Acme/App");
        const mac = await joined("natefinch", "mac");
        const win = await joined("natefinch", "win");

        const viaUrl = await mac.bus.joinChannel(`${work.html_url}#issuecomment-1`);
        assert.deepEqual([viaUrl.repo, viaUrl.number, viaUrl.created, viaUrl.already], ["Acme/App", work.number, false, false]);
        assert.equal(viaUrl.label, `acme/app#${work.number} "Windows smoke tests for 1.4"`);
        assert.equal((await win.bus.joinChannel(`acme/app#${work.number}`)).already, false);
        assert.equal((await win.bus.joinChannel(work.html_url)).already, true);

        await mac.bus.send({ to: "*", channel: `acme/app#${work.number}`, message: "run them on windows" });
        await waitFor(() => win.prompts.length === 1);
        assert.match(win.prompts[0], /where="acme\/app#\d+ &quot;Windows smoke tests for 1\.4&quot;"/);
        assert.match(win.prompts[0], new RegExp(`channel="acme/app#${work.number}"`));
        assert.equal(fake.comments.at(-1).repo, "Acme/App");

        const { sessions: inChannel } = await mac.bus.list({ channel: work.html_url });
        assert.deepEqual(inChannel.map((s) => s.session).sort(), ["mac", "win"]);

        assert.match(await win.bus.leaveChannel(`Acme/App#${work.number}`), /Windows smoke tests/);
        assert.equal(await win.bus.leaveChannel(`Acme/App#${work.number}`), null);
        await mac.bus.send({ to: "*", channel: work.html_url, message: "after win left" });
        await settle();
        assert.equal(win.prompts.length, 1);
    });

    test("a restarted session rejoins issue channels", async () => {
        await fake.close();
        fake = createFakeGitHub({ repos: { "acme/app": {} } });
        await fake.listen();
        const work = fake.addIssue("natefinch", "Release coordination", "", "acme/app");
        const mac = await joined("natefinch", "mac");
        const win = await joined("natefinch", "win", "win-session");
        await win.bus.joinChannel(work.html_url);
        win.bus.stop();
        await mac.bus.send({ to: "natefinch/win", channel: work.html_url, message: "while you were away" });

        const restarted = makeSession("natefinch", "win-session");
        await restarted.bus.start();
        await waitFor(() => restarted.prompts.length === 1);
        assert.match(restarted.prompts[0], /while you were away/);
        assert.deepEqual(restarted.bus.status().channels, [`acme/app#${work.number} "Release coordination"`]);
    });

    test("peer_channel_create makes a linked channel issue and joins it", async () => {
        await fake.close();
        fake = createFakeGitHub({ repos: { "acme/app": {}, "acme/secret": { members: ["alice"] } } });
        await fake.listen();
        const bug = fake.addIssue("alice", "Crash on startup", "", "acme/app");
        const mac = await joined("natefinch", "mac");

        const inBus = await mac.bus.createChannel({ title: "Startup crash: repro on all OSes", about: bug.html_url });
        assert.equal(inBus.inBusRepo, true);
        const created = fake.issues.find((i) => i.title === "Startup crash: repro on all OSes");
        assert.equal(created.repo, "acme/bus");
        assert.match(created.body, new RegExp(`Related: ${bug.html_url}`));
        assert.deepEqual(mac.bus.status().channels, [`acme/bus#${created.number} "Startup crash: repro on all OSes"`]);

        const inApp = await mac.bus.createChannel({ title: "Agents: crash triage", repo: "acme/app" });
        assert.equal(inApp.inBusRepo, false);
        assert.equal(fake.issues.find((i) => i.title === "Agents: crash triage").repo, "acme/app");

        await assert.rejects(mac.bus.createChannel({ title: "x", repo: "acme/secret" }), /Can't create an issue in acme\/secret/);
        await assert.rejects(mac.bus.createChannel({ title: "[peer-bus] inbox: @natefinch" }), /reserved/);
        await assert.rejects(mac.bus.createChannel({ title: "x", about: "see the crash bug" }), /isn't an issue or pull request reference/);
    });

    test("channel joins reject inaccessible issues, pull requests, and inboxes", async () => {
        await fake.close();
        fake = createFakeGitHub({ repos: { "acme/secret": { members: ["alice"] }, "acme/app": {} } });
        await fake.listen();
        const secret = fake.addIssue("alice", "secret plans", "", "acme/secret");
        const pull = fake.addIssue("natefinch", "a PR", "", "acme/app", { pull: true });
        const mac = await joined("natefinch", "mac");
        await assert.rejects(mac.bus.joinChannel(secret.html_url), /Can't access acme\/secret#1/);
        await assert.rejects(mac.bus.joinChannel(`acme/app#${pull.number}`), /is a pull request/);
        await assert.rejects(mac.bus.joinChannel("https://github.com/acme/app/pull/1"), /Pull requests can't be channels/);
        const inbox = fake.issues.find((i) => i.title === "[peer-bus] inbox: @natefinch");
        await assert.rejects(mac.bus.joinChannel(`#${inbox.number}`), /personal inbox/);
        await assert.rejects(mac.bus.send({ to: "*", channel: secret.html_url, message: "x" }), /Can't access/);
        assert.deepEqual(mac.bus.status().channels, []);
    });

    test("addressed channel messages only wake the addressee", async () => {
        const mac = await joined("natefinch", "mac");
        const win = await joined("natefinch", "win");
        const linux = await joined("natefinch", "linux");
        for (const s of [mac, win, linux]) await s.bus.joinChannel("ui");
        await mac.bus.send({ to: "natefinch/linux", channel: "ui", message: "linux only" });
        await waitFor(() => linux.prompts.length === 1);
        await settle();
        assert.equal(win.prompts.length, 0);
    });
});

test("without the notifications scope, threads aren't muted and the user is told how to fix it", async () => {
    await fake.close();
    fake = createFakeGitHub({ scopes: "repo, read:org" });
    await fake.listen();
    const nate = await joined("natefinch", "mac");
    await joined("alice", "build");
    await nate.bus.send({ to: "alice/build", message: "hi" });
    assert.deepEqual(fake.unsubscribed, []);
    assert.match(nate.bus.notificationHint(), /gh auth refresh -h github.com -s notifications/);
});

describe("presence and lifecycle", () => {
    test("list shows online sessions and channels; leave removes presence", async () => {
        const mac = await joined("natefinch", "mac", undefined, { isDefault: true });
        const alice = await joined("alice", "build");
        await alice.bus.joinChannel("release");
        const { channels, sessions: online } = await mac.bus.list();
        const key = issueKey(fake.issues.find((i) => i.title === "[peer-bus] channel: release"));
        assert.deepEqual(channels, [{ id: key, label: `#release (${key})`, online: 1 }]);
        assert.deepEqual(
            online.map((s) => [`${s.login}/${s.session}`, s.isDefault, s.channels.map((c) => c.id), s.host]),
            [
                ["alice/build", false, [key], "alice-host"],
                ["natefinch/mac", true, [], "natefinch-host"],
            ]
        );
        assert.deepEqual((await mac.bus.list({ channel: "release" })).sessions.map((s) => s.session), ["build"]);

        assert.equal(await alice.bus.leave(), "alice/build");
        assert.deepEqual((await mac.bus.list()).sessions.map((s) => s.session), ["mac"]);
        assert.equal(alice.bus.joined, false);
    });

    test("a fresh duplicate name is rejected, a stale one is taken over", async () => {
        await joined("natefinch", "mac", "session-1");
        const second = makeSession("natefinch", "session-2");
        await assert.rejects(second.bus.join({ name: "MAC" }), /already on the peer bus as "natefinch\/mac"/);

        const later = makeSession("natefinch", "session-3", { now: () => Date.now() + 60 * 60_000 });
        await later.bus.join({ name: "mac" });
        const presences = fake.comments.filter((c) => c.body.includes('"type":"presence"'));
        assert.equal(presences.length, 1, "stale presence was deleted");
        assert.match(presences[0].body, new RegExp(sessionHash("session-3")));
    });

    test("a restarted session catches up on missed messages, capped at 20", async () => {
        const mac = await joined("natefinch", "mac");
        const win = await joined("natefinch", "win", "win-session");
        win.bus.stop();

        for (let i = 1; i <= 23; i++) await mac.bus.send({ to: "natefinch/win", message: `missed ${i}` });
        const restarted = makeSession("natefinch", "win-session");
        assert.equal(await restarted.bus.start(), true);
        await waitFor(() => restarted.prompts.length === 1);
        const prompt = restarted.prompts[0];
        assert.match(prompt, /^\(3 older peer message/);
        assert.doesNotMatch(prompt, /missed 3\n/);
        assert.match(prompt, /missed 4\n[\s\S]*missed 23\n/);
        assert.equal(restarted.bus.status().address, "natefinch/win");
    });

    test("falls back to polling when Alive is unavailable", async () => {
        const deadAlive = () => ({ live: false, setIssues() {}, start() {}, stop() {} });
        const mac = await joined("natefinch", "mac");
        const win = await joined("natefinch", "win", undefined, {}, { createAlive: deadAlive, fallbackPollMs: 50 });
        await mac.bus.send({ to: "natefinch/win", message: "polled" });
        await waitFor(() => win.prompts.length === 1);
        assert.equal(win.bus.status().push, "polling");
    });
});

test("GitHub client paginates and reuses ETags", async () => {
    const github = new GitHub({ repo: fake.repo, tokenProvider: async () => "tok-alice", apiUrl: fake.url });
    const issue = fake.addIssue("alice", "x");
    for (let i = 0; i < 150; i++) fake.addComment("alice", issue.number, `c${i}`);
    const ref = { repo: fake.repo, number: issue.number };
    assert.equal((await github.listComments(ref)).length, 150);
    const before = fake.stats.notModified;
    assert.equal((await github.listComments(ref)).length, 150);
    assert.equal(fake.stats.notModified - before, 2, "both pages returned 304");
});
