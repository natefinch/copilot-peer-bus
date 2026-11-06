import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { MUTE_HELP, PeerBus } from "../.github/extensions/peer-bus/bus.mjs";
import { GitHub, ghCliToken, rateLimitDelay } from "../.github/extensions/peer-bus/github.mjs";
import { parseComment } from "../.github/extensions/peer-bus/protocol.mjs";
import { SessionStore } from "../.github/extensions/peer-bus/state.mjs";
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
let channel;

async function startFake(options) {
    await fake?.close();
    fake = createFakeGitHub(options);
    await fake.listen();
    channel = fake.addIssue("natefinch", "Release testing", "", options?.repos ? Object.keys(options.repos)[0] : "acme/channels");
}

beforeEach(async () => {
    fake = null;
    await startFake();
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
    const logs = [];
    const bus = new PeerBus({
        github: new GitHub({ tokenProvider: async () => `tok-${login}`, apiUrl: fake.url }),
        store: new SessionStore(sessionId, { COPILOT_HOME: home }),
        deliver: (prompt) => prompts.push(prompt),
        notify: (text) => notes.push(text),
        log: (text) => logs.push(text),
        createAlive: (o) => new FakeAlive(fake, o),
        pollMs: 1e9,
        fallbackPollMs: 1e9,
        ...options,
    });
    const handle = { bus, prompts, notes, logs };
    sessions.push(handle);
    return handle;
}

// Joins the bus as login/name and joins the default channel.
async function inChannel(login, name, { sessionId = `${login}-${name}`, options = {}, url = channel.html_url } = {}) {
    const handle = makeSession(login, sessionId, options);
    await handle.bus.join({ name });
    await handle.bus.joinChannel(url);
    return handle;
}

const statusComments = () => fake.comments.filter((c) => parseComment({ ...c, user: { login: c.author } }).type === "heartbeat");
const reactionsOn = (commentId, content) => fake.reactions.filter((r) => r.commentId === commentId && r.content === content);
const lastComment = () => fake.comments.at(-1);

describe("joining", () => {
    test("posts a status comment with a heartbeat and mutes the issue", async () => {
        const mac = await inChannel("natefinch", "mac");
        const [status] = statusComments();
        assert.equal(status.body, "**from:** natefinch/mac\n**kind:** heartbeat");
        assert.equal(reactionsOn(status.id, "heart").length, 1);
        assert.ok(fake.mutes.some((m) => m.login === "natefinch" && m.id === channel.node_id && m.state === "IGNORED"));
        assert.deepEqual(mac.bus.status().channels, [`"Release testing" (${channel.html_url})`]);
        assert.equal((await mac.bus.joinChannel(`acme/channels#${channel.number}`)).already, true);
        assert.equal(statusComments().length, 1);
    });

    test("requires a name, an accessible issue, and not a pull request", async () => {
        await startFake({ repos: { "acme/channels": {}, "acme/secret": { members: ["alice"] } } });
        const secret = fake.addIssue("alice", "secret", "", "acme/secret");
        const pull = fake.addIssue("natefinch", "a PR", "", "acme/channels", { pull: true });
        const anon = makeSession("natefinch", "anon");
        await assert.rejects(anon.bus.joinChannel(channel.html_url), /Call peer_join/);
        await anon.bus.join({ name: "mac" });
        await assert.rejects(anon.bus.joinChannel(secret.html_url), /Can't access acme\/secret#1/);
        await assert.rejects(anon.bus.joinChannel(`acme/channels#${pull.number}`), /is a pull request/);
        await assert.rejects(anon.bus.joinChannel("release"), /Invalid channel/);
        assert.equal(statusComments().length, 0);
    });

    test("fails without the notifications scope, before posting anything", async () => {
        await startFake({ scopes: "repo, read:org" });
        const mac = makeSession("natefinch", "mac");
        await mac.bus.join({ name: "mac" });
        await assert.rejects(mac.bus.joinChannel(channel.html_url), (e) => e.message === MUTE_HELP);
        await assert.rejects(mac.bus.createChannel({ title: "x", repo: "acme/channels" }), (e) => e.message === MUTE_HELP);
        assert.equal(fake.comments.length, 0);
        assert.equal(fake.issues.length, 1);
    });

    test("rereads the token once the person adds the notifications scope", async () => {
        await startFake({ scopes: "repo, read:org", tokenScopes: { "tok-natefinch:refreshed": "repo, notifications" } });
        let token = "tok-natefinch";
        const mac = makeSession("natefinch", "mac", { github: new GitHub({ tokenProvider: async () => token, apiUrl: fake.url }) });
        await mac.bus.join({ name: "mac" });
        await assert.rejects(mac.bus.joinChannel(channel.html_url), (e) => e.message === MUTE_HELP);
        token = "tok-natefinch:refreshed";
        await mac.bus.joinChannel(channel.html_url);
        assert.equal(statusComments().length, 1);
    });

    test("a fresh duplicate name is rejected; a stale one is replaced", async () => {
        await inChannel("natefinch", "mac", { sessionId: "one" });
        const two = makeSession("natefinch", "two");
        await two.bus.join({ name: "MAC" });
        await assert.rejects(two.bus.joinChannel(channel.html_url), /already listening .* as natefinch\/mac/);

        const later = makeSession("natefinch", "three", { now: () => Date.now() + 60 * 60_000 });
        await later.bus.join({ name: "mac" });
        await later.bus.joinChannel(channel.html_url);
        assert.equal(statusComments().length, 1, "the stale status comment was deleted");
    });

    test("renaming replaces status comments; leaving removes them", async () => {
        const mac = await inChannel("natefinch", "mac");
        const other = fake.addIssue("natefinch", "Other");
        await mac.bus.joinChannel(other.html_url);
        await mac.bus.join({ name: "laptop" });
        assert.deepEqual(statusComments().map((c) => c.body.split("\n")[0]), ["**from:** natefinch/laptop", "**from:** natefinch/laptop"]);

        assert.match(await mac.bus.leaveChannel(other.html_url), /"Other"/);
        assert.equal(statusComments().length, 1);
        assert.equal(await mac.bus.leave(), "natefinch/laptop");
        assert.equal(statusComments().length, 0);
        assert.equal(mac.bus.joined, false);
    });
});

describe("messages", () => {
    test("a message to one session reaches only it, as a prompt, and gets 👀", async () => {
        const mac = await inChannel("natefinch", "mac");
        const win = await inChannel("natefinch", "win");
        const linux = await inChannel("natefinch", "linux");

        const sent = await mac.bus.send({ channel: channel.html_url, to: "natefinch/win", message: "run the windows tests" });
        assert.match(sent.id, /^m-[a-z0-9]{8}$/);
        assert.equal(lastComment().body, `**id:** ${sent.id}\n**from:** natefinch/mac\n**to:** natefinch/win\n**kind:** task\n\nrun the windows tests`);
        await waitFor(() => win.prompts.length === 1);
        await waitFor(() => reactionsOn(lastComment().id, "eyes").length === 1);
        assert.equal(reactionsOn(lastComment().id, "eyes")[0].user, "natefinch");
        assert.match(win.prompts[0], new RegExp(`<peer_message channel="${channel.html_url}" id="${sent.id}" comment="${sent.url}" from="natefinch/mac" to="natefinch/win">`));
        assert.match(win.prompts[0], new RegExp(`reply_to="${sent.url}"`));
        await settle();
        assert.equal(linux.prompts.length + mac.prompts.length, 0);
    });

    test("a login reaches all of that person's sessions; * reaches everyone else; neither gets 👀", async () => {
        const main = await inChannel("alice", "main");
        const side = await inChannel("alice", "side");
        const nate = await inChannel("natefinch", "mac");
        for (const s of [main, side]) s.bus.trust("natefinch", true);

        await nate.bus.send({ channel: channel.html_url, to: "alice", message: "flaky test?" });
        await waitFor(() => main.prompts.length === 1 && side.prompts.length === 1);
        assert.doesNotMatch(lastComment().body, /@/);

        await nate.bus.send({ channel: channel.html_url, to: "*", message: "release is cut" });
        await waitFor(() => main.prompts.length === 2 && side.prompts.length === 2);
        await settle();
        assert.equal(nate.prompts.length, 0);
        assert.equal(fake.reactions.filter((r) => r.content === "eyes").length, 0);
    });

    test("comments without headers are messages to everyone", async () => {
        const mac = await inChannel("natefinch", "mac");
        fake.addComment("natefinch", channel.number, "humans can talk here too", "acme/channels");
        await waitFor(() => mac.prompts.length === 1);
        assert.match(mac.prompts[0], /from="natefinch" to="\*"/);
        assert.doesNotMatch(mac.prompts[0], / id="/);
    });

    test("untrusted tasks become notes (with 👀) until trusted; notify never prompts", async () => {
        const alice = await inChannel("alice", "build");
        const nate = await inChannel("natefinch", "mac");

        const first = await nate.bus.send({ channel: channel.html_url, to: "alice/build", message: "please deploy" });
        await waitFor(() => alice.notes.length === 1);
        assert.match(alice.notes[0], new RegExp(`📨 ${first.id} from natefinch/mac in "Release testing".*please deploy.*not given to the agent`));
        await waitFor(() => reactionsOn(lastComment().id, "eyes").length === 1);
        assert.equal(alice.prompts.length, 0);

        alice.bus.trust("natefinch", true);
        await nate.bus.send({ channel: channel.html_url, to: "alice/build", message: "please deploy now" });
        await waitFor(() => alice.prompts.length === 1);
        await nate.bus.send({ channel: channel.html_url, to: "alice/build", message: "fyi: deployed", kind: "notify" });
        await waitFor(() => alice.notes.length === 2);
        assert.doesNotMatch(alice.notes[1], /not given to the agent/);
        assert.equal(alice.prompts.length, 1);
    });

    test("replies carry re with the message id and comment permalink, and are verified", async () => {
        const mac = await inChannel("natefinch", "mac");
        const win = await inChannel("natefinch", "win");
        const question = await mac.bus.send({ channel: channel.html_url, to: "natefinch/win", message: "which build failed?" });
        await waitFor(() => win.prompts.length === 1);

        await win.bus.send({ channel: channel.html_url, to: "natefinch/mac", message: "build 42", replyTo: question.url });
        assert.match(lastComment().body, new RegExp(`\\*\\*re:\\*\\* \\[${question.id}\\]\\(${question.url.replace(/[.?]/g, "\\$&")}\\)`));
        await waitFor(() => mac.prompts.length === 1);
        assert.match(mac.prompts[0], new RegExp(`re="${question.id}"`));

        const byId = await win.bus.send({ channel: channel.html_url, to: "natefinch/mac", message: "also 43", replyTo: question.id });
        assert.match(lastComment().body, new RegExp(`\\[${question.id}\\]`));
        await waitFor(() => mac.prompts.length === 2);
        assert.ok(byId.id);

        await assert.rejects(win.bus.send({ channel: channel.html_url, to: "*", message: "x", replyTo: "m-zzzzzzzz" }), /Can't find message/);
        await assert.rejects(win.bus.send({ channel: channel.html_url, to: "*", message: "x", replyTo: "nope" }), /reply_to must be/);

        // A forged re (wrong id for the linked comment) is dropped with a note.
        const forged = `**id:** m-forged01\n**from:** natefinch/win\n**to:** natefinch/mac\n**re:** [m-99999999](${question.url})\n**kind:** task\n\nforged`;
        fake.addComment("natefinch", channel.number, forged, "acme/channels");
        await waitFor(() => mac.prompts.length === 3);
        assert.doesNotMatch(mac.prompts[2], /re="m-99999999"/);
        assert.match(mac.prompts[2], /doesn't match the linked comment/);
    });

    test("sending needs a joined channel and valid recipients, and reports who isn't listening", async () => {
        const nate = await inChannel("natefinch", "mac");
        const other = fake.addIssue("natefinch", "Not joined");
        await assert.rejects(nate.bus.send({ to: "*", message: "x" }), /Messages go through channels/);
        await assert.rejects(nate.bus.send({ channel: other.html_url, to: "*", message: "x" }), /isn't in that channel/);
        await assert.rejects(nate.bus.send({ channel: channel.html_url, to: "natefinch/mac", message: "x" }), /itself/);
        await assert.rejects(nate.bus.send({ channel: channel.html_url, to: "@alice", message: "x" }), /no @/);

        const result = await nate.bus.send({ channel: channel.html_url, to: "alice/ghost, bob, *", message: "hi" });
        assert.deepEqual(result.notes, [
            "alice/ghost isn't listening in this channel right now. If it's joined but offline, it gets the message when it reconnects.",
            "bob has no sessions listening in this channel right now.",
            "No other sessions are listening in this channel right now.",
        ]);
    });
});

describe("presence", () => {
    test("list shows sessions with fresh heartbeats", async () => {
        const mac = await inChannel("natefinch", "mac");
        await inChannel("alice", "build");
        const [listed] = await mac.bus.list();
        assert.equal(listed.label, `"Release testing" (${channel.html_url})`);
        assert.deepEqual(listed.sessions, [
            { address: "alice/build", self: false },
            { address: "natefinch/mac", self: true },
        ]);
        const future = makeSession("bob", "observer", { now: () => Date.now() + 60 * 60_000 });
        await future.bus.join({ name: "observer" });
        assert.deepEqual((await future.bus.list({ channel: channel.html_url }))[0].sessions, [], "stale hearts are offline");
    });

    test("heartbeats re-add ❤️ and recreate a deleted status comment", async () => {
        const mac = await inChannel("natefinch", "mac");
        const [status] = statusComments();
        const before = reactionsOn(status.id, "heart")[0].id;
        await mac.bus.heartbeatAll();
        const after = reactionsOn(status.id, "heart");
        assert.equal(after.length, 1);
        assert.notEqual(after[0].id, before);

        fake.comments.splice(fake.comments.indexOf(status), 1);
        await mac.bus.heartbeatAll();
        const [recreated] = statusComments();
        assert.notEqual(recreated.id, status.id);
        assert.equal(reactionsOn(recreated.id, "heart").length, 1);
    });

    test("a restarted session reuses its status comment and catches up, capped at 20", async () => {
        const mac = await inChannel("natefinch", "mac");
        const win = await inChannel("natefinch", "win", { sessionId: "win-session" });
        win.bus.stop();
        for (let i = 1; i <= 23; i++) await mac.bus.send({ channel: channel.html_url, to: "natefinch/win", message: `missed ${i}` });

        const restarted = makeSession("natefinch", "win-session");
        assert.equal(await restarted.bus.start(), true);
        await waitFor(() => restarted.prompts.length === 1);
        assert.match(restarted.prompts[0], /^\(3 older peer message/);
        assert.match(restarted.prompts[0], /missed 4\n[\s\S]*missed 23\n/);
        assert.equal(statusComments().length, 2, "status comment reused");
        await waitFor(() => fake.reactions.filter((r) => r.content === "eyes").length === 20);
    });

    test("falls back to polling when Alive is unavailable", async () => {
        const deadAlive = () => ({ live: false, setIssues() {}, start() {}, stop() {} });
        const mac = await inChannel("natefinch", "mac");
        const win = await inChannel("natefinch", "win", { options: { createAlive: deadAlive, fallbackPollMs: 50 } });
        await mac.bus.send({ channel: channel.html_url, to: "natefinch/win", message: "polled" });
        await waitFor(() => win.prompts.length === 1);
        assert.equal(win.bus.status().push, "polling");
    });
});

test("createChannel makes a linked issue in the given repo and joins it", async () => {
    await startFake({ repos: { "acme/channels": {}, "acme/app": {}, "acme/secret": { members: ["alice"] } } });
    const bug = fake.addIssue("alice", "Crash on startup", "", "acme/app");
    const mac = makeSession("natefinch", "mac");
    await mac.bus.join({ name: "mac" });

    const created = await mac.bus.createChannel({ title: "Startup crash: repro on all OSes", repo: "acme/channels", about: bug.html_url });
    const issue = fake.issues.find((i) => i.title === "Startup crash: repro on all OSes");
    assert.equal(issue.repo, "acme/channels");
    assert.match(issue.body, new RegExp(`Related: ${bug.html_url}`));
    assert.equal(created.html_url, `https://github.com/acme/channels/issues/${issue.number}`);
    assert.ok(fake.mutes.some((m) => m.id === `I_acme/channels_${issue.number}`));
    assert.equal(statusComments().length, 1);

    await assert.rejects(mac.bus.createChannel({ title: "x" }), /Invalid repository/);
    await assert.rejects(mac.bus.createChannel({ title: "x", repo: "acme/secret" }), /Can't create an issue in acme\/secret/);
    await assert.rejects(mac.bus.createChannel({ title: "x", repo: "acme/channels", about: "#1" }), /isn't an issue or pull request reference/);
});

test("GitHub client paginates and reuses ETags", async () => {
    const github = new GitHub({ tokenProvider: async () => "tok-alice", apiUrl: fake.url });
    for (let i = 0; i < 150; i++) fake.addComment("alice", channel.number, `c${i}`, "acme/channels");
    const ref = { repo: "acme/channels", number: channel.number };
    assert.equal((await github.listComments(ref)).length, 150);
    const before = fake.stats.notModified;
    assert.equal((await github.listComments(ref)).length, 150);
    assert.equal(fake.stats.notModified - before, 2, "both pages returned 304");
});

describe("leaving and closed channels", () => {
    test("leaving posts exit_channel; others see a note, not a prompt", async () => {
        const mac = await inChannel("natefinch", "mac");
        const win = await inChannel("natefinch", "win");
        const other = fake.addIssue("natefinch", "Other");
        await win.bus.joinChannel(other.html_url);

        await win.bus.leaveChannel(channel.html_url);
        const exit = fake.comments.find((c) => c.body === "**from:** natefinch/win\n**kind:** exit_channel");
        assert.ok(exit, "exit message posted");
        assert.equal(exit.issue, channel.number);
        await waitFor(() => mac.notes.some((n) => n === `👋 natefinch/win left "Release testing" (${channel.html_url}).`));
        assert.equal(mac.prompts.length, 0);
        assert.equal(statusComments().length, 2, "win's heartbeat in the first channel is gone");

        await win.bus.leave();
        assert.equal(fake.comments.filter((c) => c.body.endsWith("**kind:** exit_channel")).length, 2);
        assert.equal(statusComments().length, 1);
        await settle();
        assert.equal(win.notes.filter((n) => n.startsWith("👋")).length, 0, "no note for your own exit");
    });

    test("a closed channel is left automatically, and closed issues can't be joined", async () => {
        const mac = await inChannel("natefinch", "mac");
        fake.closeIssue(channel.number);
        await waitFor(() => mac.notes.some((n) => n.startsWith("📪") && n.includes("was closed")));
        assert.deepEqual(mac.bus.status().channels, []);
        assert.equal(statusComments().length, 0);
        assert.equal(fake.comments.filter((c) => c.body.includes("exit_channel")).length, 0);
        await assert.rejects(mac.bus.joinChannel(channel.html_url), /is closed/);
    });

    test("a restarted session drops channels closed while it was away", async () => {
        await inChannel("natefinch", "win", { sessionId: "win-session" }).then((s) => s.bus.stop());
        fake.closeIssue(channel.number);
        const restarted = makeSession("natefinch", "win-session");
        await restarted.bus.start();
        assert.deepEqual(restarted.bus.status().channels, []);
        assert.ok(restarted.notes.some((n) => n.includes("was closed")));
    });
});

describe("history, receipts, and limits", () => {
    test("peer_history returns recent messages, oldest first, marking untrusted senders", async () => {
        const mac = await inChannel("natefinch", "mac");
        const bob = await inChannel("bob", "helper");
        await mac.bus.send({ channel: channel.html_url, to: "*", message: "first", kind: "notify" });
        await bob.bus.send({ channel: channel.html_url, to: "natefinch/mac", message: "from bob" });
        fake.addComment("natefinch", channel.number, "x".repeat(5000), "acme/channels");
        await bob.bus.leaveChannel(channel.html_url);

        const all = await mac.bus.history({ channel: channel.html_url });
        assert.match(all, /^"Release testing" \(.+\): all 4 messages, oldest first\./);
        assert.doesNotMatch(all, /heartbeat/);
        assert.match(all, /from="natefinch\/mac" to="\*" kind="notify" at="[^"]+" trusted="true">\nfirst/);
        assert.match(all, /from="bob\/helper" to="natefinch\/mac" kind="task" at="[^"]+" trusted="false">\nfrom bob/);
        assert.match(all, /x{4000}… \(truncated; see the comment\)/);
        assert.match(all, /\(bob\/helper left the channel at /);

        const last = await mac.bus.history({ channel: channel.html_url, limit: 1 });
        assert.match(last, /the last 1 of 4 messages/);
        assert.doesNotMatch(last, />\nfirst\n|from bob/);
        assert.match(last, /\(bob\/helper left the channel at /);
    });

    test("senders are told when a single addressed session reads their message", async () => {
        const mac = await inChannel("natefinch", "mac");
        await inChannel("natefinch", "win");
        const alice = await inChannel("alice", "build");
        alice.bus.trust("natefinch", true);

        const sent = await mac.bus.send({ channel: channel.html_url, to: "natefinch/win, alice/build", message: "both of you" });
        await waitFor(() => mac.notes.filter((n) => n.startsWith("👀")).length === 2);
        assert.deepEqual(mac.notes.filter((n) => n.startsWith("👀")).sort(), [
            `👀 alice/build read ${sent.id} in "Release testing" (${channel.html_url}).`,
            `👀 natefinch/win read ${sent.id} in "Release testing" (${channel.html_url}).`,
        ]);

        await mac.bus.send({ channel: channel.html_url, to: "*", message: "everyone" });
        await settle();
        assert.equal(mac.bus.receipts.get(`acme/channels#${channel.number}`)?.size ?? 0, 0, "broadcasts aren't tracked");
    });

    test("messages over GitHub's comment limit are rejected", async () => {
        const mac = await inChannel("natefinch", "mac");
        const before = fake.comments.length;
        await assert.rejects(
            mac.bus.send({ channel: channel.html_url, to: "*", message: "y".repeat(65_500) }),
            /too long: 65,5\d\d characters with headers.*limited to 65,536.*gist/
        );
        assert.equal(fake.comments.length, before);
    });
});

describe("rate limits", () => {
    const headers = (h) => new Headers(h);

    test("rateLimitDelay follows GitHub's guidance", () => {
        assert.equal(rateLimitDelay(403, headers({ "retry-after": "30" }), "", 0), 30_000);
        assert.equal(rateLimitDelay(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1010" }), "", 0, 1_000_000), 11_000);
        assert.equal(rateLimitDelay(403, headers({}), "You have exceeded a secondary rate limit", 0), 60_000);
        assert.equal(rateLimitDelay(403, headers({}), "You have exceeded a secondary rate limit", 1), 120_000);
        assert.equal(rateLimitDelay(429, headers({}), "", 0), 60_000);
        assert.equal(rateLimitDelay(403, headers({}), "Resource not accessible by integration", 0), null);
        assert.equal(rateLimitDelay(404, headers({ "retry-after": "5" }), "", 0), null);
    });

    function client(options = {}) {
        const sleeps = [];
        const github = new GitHub({ tokenProvider: async () => "tok-natefinch", apiUrl: fake.url, sleep: async (ms) => sleeps.push(ms), ...options });
        return { github, sleeps };
    }

    test("rate-limited requests are retried after the indicated wait", async () => {
        const { github, sleeps } = client();
        fake.failNext(1, { status: 403, message: "You have exceeded a secondary rate limit", headers: { "Retry-After": "7" }, method: "POST" });
        fake.failNext(1, { status: 403, message: "You have exceeded a secondary rate limit", method: "POST" });
        const comment = await github.createComment({ repo: "acme/channels", number: channel.number }, "hello");
        assert.equal(comment.body, "hello");
        assert.deepEqual(sleeps, [7000, 120_000]);
        assert.equal(fake.comments.length, 1);
    });

    test("gives up with a clear error when the wait would be too long, and never retries other 403s", async () => {
        const { github, sleeps } = client();
        fake.failNext(1, { status: 403, message: "API rate limit exceeded", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } });
        await assert.rejects(github.getIssue({ repo: "acme/channels", number: channel.number }), /API rate limit exceeded GitHub rate limit: try again after/);
        assert.deepEqual(sleeps, []);

        fake.failNext(1, { status: 403, message: "Resource not accessible by integration" });
        await assert.rejects(github.getIssue({ repo: "acme/channels", number: channel.number }), (e) => e.status === 403 && !/try again/.test(e.message));
        assert.deepEqual(sleeps, []);
    });
});

describe("ghCliToken", () => {
    // Fake `gh auth token`: the environment token if one is set, else the stored login (if any).
    function fakeGh(stored) {
        const calls = [];
        const run = async (env) => {
            calls.push(env);
            return env.GH_TOKEN ?? env.GITHUB_TOKEN ?? stored;
        };
        return { run, calls };
    }

    test("prefers gh's stored login over GH_TOKEN and GITHUB_TOKEN", async () => {
        const { run, calls } = fakeGh("tok-stored");
        assert.equal(await ghCliToken({ env: { GH_TOKEN: "tok-app", GITHUB_TOKEN: "tok-ci", PATH: "/bin" }, run }), "tok-stored");
        assert.deepEqual(calls, [{ PATH: "/bin" }]);
    });

    test("falls back to the environment token when gh has no stored login", async () => {
        const { run } = fakeGh(null);
        assert.equal(await ghCliToken({ env: { GH_TOKEN: "tok-app" }, run }), "tok-app");
        await assert.rejects(ghCliToken({ env: {}, run }), /gh auth login/);
    });
});
