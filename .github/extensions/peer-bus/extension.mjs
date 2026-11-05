// Copilot session extension: lets sessions on different machines message each other through a peer-bus relay.

import { joinSession } from "@github/copilot-sdk/extension";

import {
    NAME_PATTERN,
    PeerBusClient,
    clearJoinedName,
    formatIncoming,
    loadConfig,
    loadJoinedName,
    saveConfig,
    saveJoinedName,
} from "./client.mjs";

const sessionId = process.env.SESSION_ID;
let client = null;
let lastLoggedState = null;
let session;

function log(message, level = "info") {
    session?.log(`peer-bus: ${message}`, { level }).catch(() => {});
}

function onStatus(state, detail) {
    if (state === "connected" && lastLoggedState !== "connected") {
        log(`connected as "${client?.name}"`);
    } else if (state === "disconnected" && lastLoggedState === "connected") {
        log(`lost connection to relay (${detail}); reconnecting`, "warning");
    } else if (state === "replaced") {
        log(`another session joined as "${client?.name}", so this session left the peer bus`, "warning");
        clearJoinedName(sessionId);
        client = null;
    } else if (state === "unauthorized") {
        log("relay rejected the token; check PEER_BUS_TOKEN / config.json", "error");
        client = null;
    } else if (state === "error") {
        log(detail, "warning");
    }
    if (state !== "connecting" && state !== "error") lastLoggedState = state;
}

function onMessage(message) {
    if (!client) return;
    session.send({ prompt: formatIncoming(message, client.name) }).catch((error) => {
        log(`failed to deliver message ${message.id} to the session: ${error.message}`, "error");
    });
}

async function join(name) {
    const config = loadConfig();
    if (!config.url) {
        throw new Error(
            "No relay configured. Call peer_configure with the relay URL and token first (or set PEER_BUS_URL/PEER_BUS_TOKEN)."
        );
    }
    await client?.stop();
    lastLoggedState = null;
    client = new PeerBusClient({ ...config, name, onMessage, onStatus });
    client.start();
    saveJoinedName(sessionId, name);
}

async function leave() {
    const current = client;
    client = null;
    await current?.stop();
    clearJoinedName(sessionId);
    return current?.name ?? null;
}

function requireClient() {
    if (!client) throw new Error('This session has not joined the peer bus. Call peer_join first.');
    return client;
}

const tools = [
    {
        name: "peer_configure",
        description:
            "Save the peer-bus relay URL and shared token for every Copilot session for this user on this machine. " +
            "If this session has already joined, it reconnects using the new settings.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "Relay base URL, e.g. http://192.168.1.10:7777" },
                token: { type: "string", description: "Shared token the relay was started with (PEER_BUS_TOKEN)." },
            },
            required: ["url", "token"],
        },
        skipPermission: true,
        defer: "never",
        handler: async ({ url, token }) => {
            const config = saveConfig({ url, token });
            let health;
            try {
                const response = await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) });
                health = response.ok ? "The relay is reachable." : `Warning: the relay returned HTTP ${response.status}.`;
            } catch (error) {
                health = `Warning: could not reach the relay (${error.cause?.message ?? error.message}).`;
            }
            const overridden = process.env.PEER_BUS_URL || process.env.PEER_BUS_TOKEN
                ? " Note: PEER_BUS_URL/PEER_BUS_TOKEN environment variables are set and take precedence."
                : "";
            if (client) await join(client.name);
            return `Saved relay settings for ${config.url}. ${health}${overridden}`;
        },
    },
    {
        name: "peer_join",
        description:
            "Join the peer bus under a unique name so Copilot sessions on other machines can message this session. " +
            "The session automatically rejoins with this name after restarts. Joining again with a different name renames it.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Unique peer name, e.g. windows-tester. Letters, digits, '.', '_' or '-'; max 64 chars.",
                    pattern: NAME_PATTERN.source,
                },
            },
            required: ["name"],
        },
        skipPermission: true,
        defer: "never",
        handler: async ({ name }) => {
            if (!NAME_PATTERN.test(name ?? "")) throw new Error(`Invalid name "${name}".`);
            await join(name);
            return `Joined the peer bus as "${name}". Incoming peer messages will arrive as new prompts in this session.`;
        },
    },
    {
        name: "peer_leave",
        description: "Leave the peer bus. This session stops receiving peer messages and will not rejoin automatically.",
        parameters: { type: "object", properties: {} },
        skipPermission: true,
        defer: "never",
        handler: async () => {
            const name = await leave();
            return name ? `Left the peer bus (was "${name}").` : "This session was not on the peer bus.";
        },
    },
    {
        name: "peer_list",
        description: "List Copilot sessions currently connected to the peer bus, with their host and OS platform.",
        parameters: { type: "object", properties: {} },
        skipPermission: true,
        defer: "never",
        handler: async () => {
            const current = requireClient();
            const peers = await current.peers();
            const lines = peers.map(
                (peer) =>
                    `- ${peer.name}${peer.name === current.name ? " (this session)" : ""}: host=${peer.host || "?"} platform=${peer.platform || "?"} since ${peer.connectedAt}`
            );
            return [`This session is "${current.name}" (${current.state}).`, ...lines].join("\n");
        },
    },
    {
        name: "peer_send",
        description:
            "Send a message to another Copilot session on the peer bus. The recipient receives it as a new prompt. " +
            'Use to="*" to broadcast to every other connected peer. Messages to an offline peer are queued for up to an hour.',
        parameters: {
            type: "object",
            properties: {
                to: { type: "string", description: 'Recipient peer name, or "*" for all other peers.' },
                message: { type: "string", description: "Self-contained message text for the recipient agent." },
            },
            required: ["to", "message"],
        },
        skipPermission: true,
        defer: "never",
        handler: async ({ to, message }) => {
            const current = requireClient();
            if (to === current.name) throw new Error("Cannot send a peer message to this session itself.");
            const result = await current.send(to, message);
            if (result.delivered.length > 0) return `Delivered to ${result.delivered.join(", ")} (id ${result.id}).`;
            if (result.queued.length > 0) return `"${to}" is offline; message queued for up to an hour (id ${result.id}).`;
            return "No other peers are connected; the broadcast was not delivered.";
        },
    },
];

session = await joinSession({ tools });

const savedName = sessionId ? loadJoinedName(sessionId) : null;
if (savedName) {
    join(savedName).catch((error) => log(`could not rejoin as "${savedName}": ${error.message}`, "warning"));
}
