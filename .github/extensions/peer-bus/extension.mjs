// Copilot session extension: lets sessions on different machines and of different people message each other
// through GitHub issues used as channels, with GitHub Alive pushing new messages. See README.md.

import os from "node:os";

import { joinSession } from "@github/copilot-sdk/extension";

import { AliveWatcher } from "./alive.mjs";
import { PeerBus } from "./bus.mjs";
import { GitHub } from "./github.mjs";
import { SESSION_NAME } from "./protocol.mjs";
import { SessionStore } from "./state.mjs";

const env = process.env;
const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

let session;

function log(text, level = "info") {
    session?.log(`peer-bus: ${text}`, { level, ephemeral: level === "info" }).catch(() => {});
}

const bus = new PeerBus({
    github: new GitHub({ apiUrl: env.PEER_BUS_API_URL || undefined }),
    store: new SessionStore(env.SESSION_ID ?? "unknown-session"),
    host: os.hostname(),
    platform: process.platform,
    deliver: (prompt) => session.send({ prompt }).catch((e) => log(`could not deliver a message: ${e.message}`, "error")),
    notify: (text) => session.log(text, { level: "info" }).catch(() => {}),
    log,
    createAlive: (options) => new AliveWatcher({ ...options, WebSocketImpl: env.PEER_BUS_ALIVE === "0" ? undefined : globalThis.WebSocket }),
    pollMs: positive(env.PEER_BUS_POLL_MS, 60_000),
    fallbackPollMs: positive(env.PEER_BUS_FALLBACK_POLL_MS, 10_000),
});

const CHANNEL_DESCRIPTION = "Channel issue URL (https://github.com/owner/repo/issues/123) or owner/repo#123.";

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
        description: "Leave the peer bus: leave every channel and stop rejoining automatically.",
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
            "Join a peer-bus channel. A channel is a GitHub issue; this posts a status comment there and mutes the issue so bus " +
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
            "peer_channel_join. Use a repository dedicated to channels: people watching the repository who aren't in the channel get " +
            "GitHub notifications for its messages. Pass `about` to link the related issue or pull request.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "Channel issue title, e.g. 'Windows smoke tests for 1.4'" },
                repo: { type: "string", description: "Repository (owner/name) to create the channel issue in." },
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
        description: "Leave a peer-bus channel. Deletes this session's status comment there.",
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
                lines.push(...(c.sessions.length ? c.sessions.map((s) => `- ${s.address}${s.self ? " (this session)" : ""}: ${s.host || "?"}`) : ["- no one listening"]));
            }
            return lines.join("\n");
        },
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
];

session = await joinSession({ tools });

try {
    await bus.start();
} catch (error) {
    log(`could not start: ${error.message}`, "warning");
}

