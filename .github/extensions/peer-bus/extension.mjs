// Copilot session extension: lets sessions on different machines and of different people message each other
// through GitHub issues used as channels, with GitHub Alive pushing new messages.
// Source: https://github.com/natefinch/copilot-peer-bus (see README.md there).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { joinSession } from "@github/copilot-sdk/extension";

import { AliveWatcher } from "./alive.mjs";
import { openInBrowser, startScopeFlow } from "./auth.mjs";
import { PeerBus } from "./bus.mjs";
import { GitHub } from "./github.mjs";
import { SESSION_NAME } from "./protocol.mjs";
import { SessionStore, UserSettings } from "./state.mjs";
import { SOURCE_URL, Updater, fileShas, isProjectCopy } from "./update.mjs";

const env = process.env;
const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

let session;

function log(text, level = "info") {
    session?.log(`peer-bus: ${text}`, { level, ephemeral: level === "info" }).catch(() => {});
}

const extensionDir = path.dirname(fileURLToPath(import.meta.url));

const github = new GitHub({
    apiUrl: env.PEER_BUS_API_URL || undefined,
    onRateLimit: (ms) => log(`GitHub rate limit reached; retrying in ${Math.ceil(ms / 1000)}s`, "warning"),
});

const updater = new Updater({
    github,
    dir: extensionDir,
    // What this process runs, to tell whether files installed since (by any session) need a reload.
    loaded: await fileShas(extensionDir),
    // Reloading stops this process, so let a tool's result reach the agent first.
    reload: ({ commit, summary }) => {
        session.log(`peer-bus: updated to ${commit.slice(0, 7)} (${summary}); reloading extensions.`, { level: "info" }).catch(() => {});
        setTimeout(() => session.rpc.extensions.reload().catch((e) => log(`could not reload extensions: ${e.message}`, "error")), 1000);
    },
});

const bus = new PeerBus({
    github,
    store: new SessionStore(env.SESSION_ID ?? "unknown-session"),
    deliver: (prompt) => session.send({ prompt }).catch((e) => log(`could not deliver a message: ${e.message}`, "error")),
    notify: (text) => session.log(text, { level: "info" }).catch(() => {}),
    log,
    requestScope: () => offerNotificationsScope(),
    createAlive: (options) => new AliveWatcher({ ...options, WebSocketImpl: env.PEER_BUS_ALIVE === "0" ? undefined : globalThis.WebSocket }),
    pollMs: positive(env.PEER_BUS_POLL_MS, 60_000),
    fallbackPollMs: positive(env.PEER_BUS_FALLBACK_POLL_MS, 10_000),
});

const CHANNEL_DESCRIPTION = "Channel issue URL (https://github.com/owner/repo/issues/123) or owner/repo#123.";

const SCOPE_OFFER =
    "peer-bus needs your GitHub CLI login to have the notifications scope, so it can mute channel issues and bus " +
    "messages don't send you GitHub notifications. Sign in again now to add it? You'll enter a one-time code in your browser.";

let scopeOffer = null;
const settings = new UserSettings();
const DECLINED = "declinedScopeOffer";

// Offers to add the notifications scope with gh's device flow; resolves to whether the token has it afterwards.
// Concurrent callers (the startup check and tools) share one offer. Once the person declines, in any session,
// it never asks again.
function offerNotificationsScope() {
    scopeOffer ??= runScopeOffer().finally(() => (scopeOffer = null));
    return scopeOffer;
}

async function runScopeOffer() {
    if (!session?.capabilities?.ui?.elicitation || settings.get(DECLINED)) return false;
    if (!(await session.ui.confirm(SCOPE_OFFER))) {
        settings.set(DECLINED, true);
        await session
            .log(
                "peer-bus won't ask again. To add the scope later, run `gh auth refresh -h github.com -s notifications` in a " +
                    "terminal where GH_TOKEN and GITHUB_TOKEN aren't set.",
                { level: "info" },
            )
            .catch(() => {});
        return false;
    }
    try {
        // Another session may have added the scope while the dialog was open.
        if (await hasScope()) return true;
        const { code, url, copied, done } = await startScopeFlow();
        openInBrowser(url);
        await session.log(
            `peer-bus: enter the code ${code} at ${url}${copied ? " (gh copied it to your clipboard)" : ""} to add the notifications scope.`,
            { level: "warning" },
        );
        await done;
        const added = await hasScope();
        await session.log(added ? "peer-bus: ✅ the GitHub CLI login now has the notifications scope." : "peer-bus: gh finished, but its login still lacks the notifications scope.", {
            level: added ? "info" : "warning",
        });
        return added;
    } catch (error) {
        await session.log(`peer-bus: could not add the notifications scope: ${error.message}`, { level: "warning" }).catch(() => {});
        return false;
    }
}

// Rereads the token and reports whether it has the notifications scope (true when GitHub doesn't say).
async function hasScope() {
    try {
        await github.reauthenticate();
    } catch (error) {
        if (error.noToken) return false;
        throw error;
    }
    return bus.hasMuteScope();
}

// Tests the current login at startup and offers to fix a missing notifications scope.
async function checkScope() {
    try {
        if (!(await hasScope())) await offerNotificationsScope();
    } catch (error) {
        log(`could not check the GitHub CLI login: ${error.message}`, "warning");
    }
}

// The app replaces a thrown error's message with "Tool execution failed", hiding instructions such as how
// to add the notifications scope. Returning the failure as a result lets the agent read and relay it.
function reportFailures(tool) {
    return {
        ...tool,
        handler: async (...args) => {
            try {
                return await tool.handler(...args);
            } catch (error) {
                return { textResultForLlm: `Error: ${error.message}`, resultType: "failure", error: error.message };
            }
        },
    };
}

const tools = [
    {
        name: "peer_join",
        description:
            "Join the peer bus as <your GitHub login>/<name>. Required before joining channels. The session rejoins automatically " +
            "after restarts. Joining again with a different name renames this session in all its channels.",
        parameters: {
            type: "object",
            properties: { name: { type: "string", description: "Session name, e.g. windows-tester", pattern: SESSION_NAME.source } },
            required: ["name"],
        },
        skipPermission: true,
        defer: "never",
        handler: async ({ name }) => {
            const { address } = await bus.join({ name });
            const status = bus.status();
            return (
                `Joined the peer bus as ${address}. Push: ${status.push}. ` +
                `Channels: ${status.channels.join(", ") || "none yet (use peer_channel_join or peer_channel_create)"}.`
            );
        },
    },
    {
        name: "peer_leave",
        description: "Leave the peer bus: post an exit message in every channel, leave them, and stop rejoining automatically.",
        parameters: { type: "object", properties: {} },
        skipPermission: true,
        handler: async () => {
            const name = await bus.leave();
            return name ? `Left the peer bus (was ${name}).` : "This session wasn't on the peer bus.";
        },
    },
    {
        name: "peer_channel_join",
        description:
            "Join a peer-bus channel. A channel is a GitHub issue; this posts a heartbeat comment there and mutes the issue so bus " +
            "traffic doesn't send you GitHub notifications. Messages in the channel addressed to this session, its owner, or * arrive here.",
        parameters: { type: "object", properties: { channel: { type: "string", description: CHANNEL_DESCRIPTION } }, required: ["channel"] },
        skipPermission: true,
        handler: async ({ channel }) => {
            const result = await bus.joinChannel(channel);
            if (result.already) return `Already in ${result.label}.`;
            const closed = result.state === "closed" ? " Note: the issue is closed." : "";
            return `Joined ${result.label}.${closed}`;
        },
    },
    {
        name: "peer_channel_create",
        description:
            "Create a new GitHub issue to use as a peer-bus channel, and join it. Returns the URL to share; other sessions join with " +
            "peer_channel_join. If the user doesn't say which repository to create it in, use the current repository. " +
            "Pass `about` to link the related issue or pull request.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "Channel issue title, e.g. 'Windows smoke tests for 1.4'" },
                repo: { type: "string", description: "Repository (owner/name) to create the channel issue in; the current repository unless the user names another." },
                about: { type: "string", description: "Related issue or pull request URL (or owner/repo#123) to link." },
            },
            required: ["title", "repo"],
        },
        skipPermission: true,
        handler: async ({ title, repo, about }) => {
            const result = await bus.createChannel({ title, repo, about });
            return `Created and joined ${result.label}. Share this URL so other sessions can join: ${result.html_url}`;
        },
    },
    {
        name: "peer_channel_leave",
        description: "Leave a peer-bus channel: posts an exit message there and deletes this session's heartbeat comment.",
        parameters: { type: "object", properties: { channel: { type: "string", description: CHANNEL_DESCRIPTION } }, required: ["channel"] },
        skipPermission: true,
        handler: async ({ channel }) => {
            const left = await bus.leaveChannel(channel);
            return left ? `Left ${left}.` : `Not in ${channel}.`;
        },
    },
    {
        name: "peer_list",
        description: "Show this session's peer-bus status and the sessions listening in its channels (or in one given channel).",
        parameters: { type: "object", properties: { channel: { type: "string", description: CHANNEL_DESCRIPTION } } },
        skipPermission: true,
        defer: "never",
        handler: async ({ channel } = {}) => {
            const status = bus.status();
            if (!status) return "This session hasn't joined the peer bus. Call peer_join with a session name.";
            const channels = await bus.list({ channel });
            const lines = [`This session: ${status.address} · push ${status.push} · trusted: ${status.trusted.join(", ") || "only yourself"}`];
            if (channels.length === 0) lines.push("Not in any channels.");
            for (const c of channels) {
                lines.push(`${c.label}${c.joined ? "" : " (not joined)"}:`);
                lines.push(...(c.sessions.length ? c.sessions.map((s) => `- ${s.address}${s.self ? " (this session)" : ""}`) : ["- no one listening"]));
            }
            return lines.join("\n");
        },
    },
    {
        name: "peer_history",
        description:
            "Read recent messages in a peer-bus channel, oldest first, to catch up on context (for example after joining late or " +
            "after /clear). Works for any channel issue you can access. Messages from untrusted senders are marked trusted=\"false\".",
        parameters: {
            type: "object",
            properties: {
                channel: { type: "string", description: CHANNEL_DESCRIPTION },
                limit: { type: "number", description: "How many recent messages to return (1-100, default 20)." },
            },
            required: ["channel"],
        },
        skipPermission: true,
        handler: async ({ channel, limit }) => bus.history({ channel, limit }),
    },
    {
        name: "peer_send",
        description:
            "Post a message in a peer-bus channel this session has joined. Addresses: 'login/session' (one session), 'login' (all of " +
            "that person's sessions in the channel), or '*' (everyone in the channel). kind 'task' asks the recipients' agents to act " +
            "(if they trust you); 'notify' only informs the people. To reply to a message, pass its id or comment URL as reply_to.",
        parameters: {
            type: "object",
            properties: {
                channel: { type: "string", description: CHANNEL_DESCRIPTION },
                to: { type: "string", description: "Recipient address; separate multiple addresses with commas. Never use @." },
                message: { type: "string", description: "Self-contained message text." },
                kind: { type: "string", enum: ["task", "notify"], description: "Default task." },
                reply_to: { type: "string", description: "The message being replied to: its id (m-…) or its comment URL." },
            },
            required: ["channel", "to", "message"],
        },
        skipPermission: true,
        defer: "never",
        handler: async ({ channel, to, message, kind, reply_to: replyTo }) => {
            const { id, url, notes } = await bus.send({ channel, to, message, kind, replyTo });
            return [`Sent ${id}: ${url}`, ...notes].join("\n");
        },
    },
    {
        name: "peer_trust",
        description:
            "Allow (or stop allowing) a GitHub user's peer-bus messages to be given to this session's agent as tasks. " +
            "Messages from untrusted people are shown to the human only. Your own login is always trusted.",
        parameters: {
            type: "object",
            properties: {
                login: { type: "string", description: "GitHub login" },
                trusted: { type: "boolean", description: "true to trust (default), false to revoke." },
            },
            required: ["login"],
        },
        handler: async ({ login, trusted = true }) => {
            const list = bus.trust(login, trusted);
            return `${trusted ? "Trusting" : "No longer trusting"} ${login}. Trusted in this session: ${list.join(", ") || "only yourself"}.`;
        },
    },
    {
        name: "peer_update",
        description:
            `Update the peer-bus extension: download the latest code from its source repository (${SOURCE_URL}), install it over ` +
            "this copy, and reload this session's extensions to run it. The session rejoins its channels automatically. Sessions " +
            "also check for updates hourly and install them on their own. Asks the user for permission.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            const { commit, summary, written, stale } = await updater.update();
            const version = `${commit.slice(0, 7)} (${summary})`;
            if (!stale) return `peer-bus is up to date: ${version}.`;
            const installed = written.length ? `Installed ${version} from ${SOURCE_URL} (${written.join(", ")})` : `${version} was already installed`;
            return `${installed}. Reloading extensions now to run it.`;
        },
    },
];

session = await joinSession({ tools: tools.map(reportFailures) });

try {
    await bus.start();
} catch (error) {
    log(`could not start: ${error.message}`, "warning");
}

checkScope();

if (env.PEER_BUS_AUTO_UPDATE !== "0" && !isProjectCopy(extensionDir)) {
    updater.start(positive(env.PEER_BUS_UPDATE_CHECK_MS, 60 * 60_000), (error) => log(`could not check for updates: ${error.message}`));
}

