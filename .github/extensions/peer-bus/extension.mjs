// Copilot session extension: lets sessions on different machines and of different people message each
// other through GitHub issues, with GitHub Alive pushing new messages. See DESIGN.md.

import os from "node:os";

import { joinSession } from "@github/copilot-sdk/extension";

import { AliveWatcher } from "./alive.mjs";
import { PeerBus } from "./bus.mjs";
import { GitHub } from "./github.mjs";
import { SESSION_NAME, issueKey } from "./protocol.mjs";
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
                `Push: ${status.push}. Channels: ${status.channels.join(", ") || "none (use peer_channel_join or peer_channel_create)"}. ` +
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
        description:
            "Join a peer-bus channel. A channel is a GitHub issue: pass its URL (e.g. https://github.com/acme/app/issues/123) " +
            "or owner/repo#123. " +
            "Channel messages addressed to this session or to * arrive here.",
        parameters: {
            type: "object",
            properties: { channel: { type: "string", description: "Channel issue URL or owner/repo#123." } },
            required: ["channel"],
        },
        skipPermission: true,
        handler: async ({ channel }) => {
            const result = await requireBus().joinChannel(channel);
            if (result.already) return `Already in ${result.label}.`;
            const closed = result.state === "closed" ? " Note: the issue is closed." : "";
            return `Joined ${result.label}.${closed} Use channel="${issueKey(result)}" with peer_send.`;
        },
    },
    {
        name: "peer_channel_create",
        description:
            "Create a new GitHub issue to use as a peer-bus channel and join it. Returns the URL to share; other sessions join with " +
            "peer_channel_join. Prefer a new channel issue over an existing work issue, so agent traffic doesn't clutter it, and pass " +
            "`about` to link the related issue or pull request. Created in the bus repository unless `repo` is given.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "Channel issue title, e.g. 'Windows smoke tests for 1.4'" },
                about: { type: "string", description: "Related issue or pull request URL (or owner/repo#123) to link." },
                repo: { type: "string", description: "Repository (owner/name) to create the issue in. Defaults to the bus repository." },
            },
            required: ["title"],
        },
        skipPermission: true,
        handler: async ({ title, about, repo }) => {
            const result = await requireBus().createChannel({ title, about, repo });
            const watchers = result.inBusRepo
                ? ""
                : ` Comments on it notify people watching ${result.repo}; the bus repository avoids that.`;
            return `Created and joined ${result.label}. Share this URL so other sessions can join: ${result.html_url}.${watchers}`;
        },
    },
    {
        name: "peer_channel_leave",
        description: "Leave a peer-bus channel (issue URL or owner/repo#123).",
        parameters: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
        skipPermission: true,
        handler: async ({ channel }) => {
            const left = await requireBus().leaveChannel(channel);
            return left ? `Left ${left}.` : `Not in ${channel}.`;
        },
    },
    {
        name: "peer_list",
        description:
            "Show this session's peer-bus status, the channels online sessions are in, " +
            "and online sessions, optionally only those in one channel.",
        parameters: {
            type: "object",
            properties: { channel: { type: "string", description: "Only show sessions in this channel (issue URL or owner/repo#123)." } },
        },
        skipPermission: true,
        defer: "never",
        handler: async ({ channel } = {}) => {
            const current = requireBus();
            const status = current.status();
            const { channels, sessions } = await current.list({ channel });
            const self = status
                ? `This session: ${status.address}${status.isDefault ? " (default)" : ""} · push ${status.push} · channels: ${status.channels.join(", ") || "none"} · trusted: ${status.trusted.join(", ") || "only yourself"}`
                : "This session hasn't joined the peer bus.";
            const lines = sessions.map((s) => {
                const isSelf = status && `${s.login}/${s.session}`.toLowerCase() === status.address.toLowerCase();
                const tags = [isSelf && "this session", s.isDefault && "default"].filter(Boolean).join(", ");
                return `- ${s.login}/${s.session}${tags ? ` (${tags})` : ""}: ${s.host || "?"}, ${s.platform || "?"} · ${s.channels.map((c) => c.id).join(", ") || "no channels"}`;
            });
            return [
                self,
                "Channels:",
                ...(channels.length ? channels.map((c) => `- ${c.label}: ${c.online} online`) : ["- none"]),
                `Online sessions${channel ? ` in ${channel}` : ""}:`,
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
                channel: { type: "string", description: "Channel to post in (issue URL or owner/repo#123). Omit for a direct message." },
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
