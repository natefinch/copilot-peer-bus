// Copilot session extension: lets sessions on different machines and of different people message each
// other through GitHub issues, with GitHub Alive pushing new messages. See DESIGN.md.

import os from "node:os";

import { joinSession } from "@github/copilot-sdk/extension";

import { AliveWatcher } from "./alive.mjs";
import { PeerBus } from "./bus.mjs";
import { GitHub } from "./github.mjs";
import { CHANNEL_NAME, SESSION_NAME } from "./protocol.mjs";
import { SessionStore, loadConfig, saveConfig, sessionHash } from "./state.mjs";

const env = process.env;
const sessionId = env.SESSION_ID ?? "unknown-session";
const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

let session;
let bus = null;

function log(text, level = "info") {
    session?.log(`peer-bus: ${text}`, { level, ephemeral: level === "info" }).catch(() => {});
}

function createBus(repo) {
    return new PeerBus({
        github: new GitHub({ repo, apiUrl: env.PEER_BUS_API_URL || undefined }),
        store: new SessionStore(sessionId),
        sid: sessionHash(sessionId),
        host: os.hostname(),
        platform: process.platform,
        deliver: (prompt) => session.send({ prompt }).catch((e) => log(`could not deliver a message: ${e.message}`, "error")),
        notify: (text) => session.log(text, { level: "info" }).catch(() => {}),
        log,
        createAlive: (options) =>
            new AliveWatcher({ ...options, WebSocketImpl: env.PEER_BUS_ALIVE === "0" ? undefined : globalThis.WebSocket }),
        pollMs: positive(env.PEER_BUS_POLL_MS, 60_000),
        fallbackPollMs: positive(env.PEER_BUS_FALLBACK_POLL_MS, 10_000),
    });
}

function requireBus() {
    if (!bus) throw new Error("The peer bus isn't configured on this machine. Call peer_configure with the bus repository (owner/name).");
    return bus;
}

const channelList = (channels) => channels.map((c) => `#${c}`).join(", ");

const tools = [
    {
        name: "peer_configure",
        description:
            "Set the GitHub repository (owner/name) that hosts the peer bus for every Copilot session for this user on this machine. " +
            "Use a private repository: everyone with access to it can message joined sessions. Also stops watching that repository so " +
            "bus traffic doesn't flood GitHub notifications.",
        parameters: {
            type: "object",
            properties: { repo: { type: "string", description: "Bus repository, e.g. octo-org/copilot-bus" } },
            required: ["repo"],
        },
        skipPermission: true,
        handler: async ({ repo }) => {
            const github = new GitHub({ repo, apiUrl: env.PEER_BUS_API_URL || undefined });
            const [info, login] = await Promise.all([github.getRepo(), github.login()]);
            saveConfig({ repo: github.repo });
            let unwatched = "Stopped watching the repository so bus traffic doesn't notify you.";
            await github.unwatchRepo().catch((e) => {
                unwatched = `Could not stop watching the repository (${e.message}); bus traffic may notify you.`;
            });
            bus?.stop();
            bus = createBus(github.repo);
            const resumed = await bus.start();
            const visibility = info.private ? "private" : "PUBLIC: anyone can read messages; use a private repository";
            const scopeHint = github.scopes && !github.scopes.has("notifications") ? bus.notificationHint() : null;
            return [
                `Configured the peer bus on ${github.repo} (${visibility}) as ${login}. ${unwatched}`,
                resumed ? `This session rejoined as ${bus.status()?.address}.` : "Call peer_join to join.",
                scopeHint,
            ]
                .filter(Boolean)
                .join(" ");
        },
    },
    {
        name: "peer_join",
        description:
            "Join the peer bus as <your login>/<name> so other sessions can message this one. The session rejoins automatically after " +
            "restarts. Set default=true to also receive messages addressed to you as a person (just your login). Joining again renames.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Session name, e.g. windows-tester", pattern: SESSION_NAME.source },
                default: { type: "boolean", description: "Receive messages addressed to your login. Default false." },
            },
            required: ["name"],
        },
        skipPermission: true,
        defer: "never",
        handler: async ({ name, default: isDefault = false }) => {
            const { login, inboxUrl } = await requireBus().join({ name, isDefault });
            const status = bus.status();
            return (
                `Joined the peer bus as ${login}/${name}${isDefault ? " (default session)" : ""}. Inbox: ${inboxUrl}. ` +
                `Push: ${status.push}. Channels: ${channelList(status.channels) || "none (use peer_channel_join)"}. ` +
                "Messages from trusted senders arrive as new prompts; others appear as notifications." +
                (bus.notificationHint() ? ` ${bus.notificationHint()}` : "")
            );
        },
    },
    {
        name: "peer_leave",
        description: "Leave the peer bus. This session stops receiving messages and won't rejoin automatically.",
        parameters: { type: "object", properties: {} },
        skipPermission: true,
        handler: async () => {
            const name = await bus?.leave();
            return name ? `Left the peer bus (was ${name}).` : "This session wasn't on the peer bus.";
        },
    },
    {
        name: "peer_channel_join",
        description: "Join a peer-bus channel, creating it if needed. Channel messages addressed to this session or to * arrive here.",
        parameters: {
            type: "object",
            properties: { channel: { type: "string", description: "Lowercase channel name, e.g. release-testing", pattern: CHANNEL_NAME.source } },
            required: ["channel"],
        },
        skipPermission: true,
        handler: async ({ channel }) => {
            const result = await requireBus().joinChannel(channel);
            if (result.already) return `Already in #${channel}.`;
            return `${result.created ? "Created and joined" : "Joined"} #${channel}: ${result.url}`;
        },
    },
    {
        name: "peer_channel_leave",
        description: "Leave a peer-bus channel.",
        parameters: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
        skipPermission: true,
        handler: async ({ channel }) => ((await requireBus().leaveChannel(channel)) ? `Left #${channel}.` : `Not in #${channel}.`),
    },
    {
        name: "peer_list",
        description: "Show this session's peer-bus status, the bus's channels, and online sessions (optionally only those in one channel).",
        parameters: { type: "object", properties: { channel: { type: "string", description: "Only show sessions in this channel." } } },
        skipPermission: true,
        defer: "never",
        handler: async ({ channel } = {}) => {
            const current = requireBus();
            const status = current.status();
            const { channels, sessions } = await current.list({ channel });
            const self = status
                ? `This session: ${status.address}${status.isDefault ? " (default)" : ""} · push ${status.push} · channels: ${channelList(status.channels) || "none"} · trusted: ${status.trusted.join(", ") || "only yourself"}`
                : "This session hasn't joined the peer bus.";
            const lines = sessions.map((s) => {
                const isSelf = status && `${s.login}/${s.session}`.toLowerCase() === status.address.toLowerCase();
                const tags = [isSelf && "this session", s.isDefault && "default"].filter(Boolean).join(", ");
                return `- ${s.login}/${s.session}${tags ? ` (${tags})` : ""}: ${s.host || "?"}, ${s.platform || "?"} · ${channelList(s.channels) || "no channels"}`;
            });
            return [
                self,
                `Channels: ${channelList(channels) || "none"}`,
                `Online sessions${channel ? ` in #${channel}` : ""}:`,
                ...(lines.length ? lines : ["- none"]),
            ].join("\n");
        },
    },
    {
        name: "peer_send",
        description:
            "Send a peer-bus message. Addresses: 'login/session' (one session), 'login' (that person's default sessions; also @mentions " +
            "them), or '*' (everyone in the channel). Without a channel the message goes to the recipient's inbox, so all recipients must " +
            "be the same person. kind 'task' asks the recipient's agent to act (if it trusts you); 'notify' only informs the human.",
        parameters: {
            type: "object",
            properties: {
                to: { type: "string", description: "Recipient address; separate multiple addresses with commas." },
                message: { type: "string", description: "Self-contained message text." },
                channel: { type: "string", description: "Channel to post in. Omit for a direct message." },
                kind: { type: "string", enum: ["task", "notify"], description: "Default task." },
            },
            required: ["to", "message"],
        },
        skipPermission: true,
        defer: "never",
        handler: async ({ to, message, channel, kind }) => {
            const { url, notes } = await requireBus().send({ to, message, channel, kind });
            return [`Sent: ${url}`, ...notes].join("\n");
        },
    },
    {
        name: "peer_trust",
        description:
            "Allow (or stop allowing) a GitHub user's peer-bus messages to be given to this session's agent as tasks. " +
            "Messages from untrusted people are shown to the human as notifications only. Your own login is always trusted.",
        parameters: {
            type: "object",
            properties: {
                login: { type: "string", description: "GitHub login" },
                trusted: { type: "boolean", description: "true to trust (default), false to revoke." },
            },
            required: ["login"],
        },
        handler: async ({ login, trusted = true }) => {
            const list = requireBus().trust(login, trusted);
            return `${trusted ? "Trusting" : "No longer trusting"} ${login}. Trusted in this session: ${list.join(", ") || "only yourself"}.`;
        },
    },
];

session = await joinSession({ tools });

const { repo } = loadConfig();
if (repo) {
    try {
        bus = createBus(repo);
        await bus.start();
    } catch (error) {
        log(`could not start: ${error.message}`, "warning");
    }
}
