// Peer-bus client used by the Copilot extension. Dependency-free: uses global fetch and streams.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function copilotHome(env = process.env) {
    return env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

export function peerBusDir(env = process.env) {
    return path.join(copilotHome(env), "peer-bus");
}

export function loadConfig(env = process.env) {
    let file = {};
    try {
        file = JSON.parse(readFileSync(path.join(peerBusDir(env), "config.json"), "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`peer-bus config.json is invalid: ${error.message}`);
    }
    const url = env.PEER_BUS_URL || file.url || "";
    const token = env.PEER_BUS_TOKEN || file.token || "";
    return { url: url.replace(/\/+$/, ""), token };
}

export function saveConfig({ url, token }, env = process.env) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid relay URL "${url}".`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Relay URL must use http or https, not ${parsed.protocol}`);
    }
    const dir = peerBusDir(env);
    mkdirSync(dir, { recursive: true });
    const config = { url: url.replace(/\/+$/, ""), token: token ?? "" };
    const file = path.join(dir, "config.json");
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return config;
}

function sessionStatePath(sessionId, env) {
    return path.join(peerBusDir(env), "sessions", `${encodeURIComponent(sessionId)}.json`);
}

export function loadJoinedName(sessionId, env = process.env) {
    try {
        const { name } = JSON.parse(readFileSync(sessionStatePath(sessionId, env), "utf8"));
        return typeof name === "string" && NAME_PATTERN.test(name) ? name : null;
    } catch {
        return null;
    }
}

export function saveJoinedName(sessionId, name, env = process.env) {
    const file = sessionStatePath(sessionId, env);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ name }));
}

export function clearJoinedName(sessionId, env = process.env) {
    rmSync(sessionStatePath(sessionId, env), { force: true });
}

// Returns a feed(text) function that parses Server-Sent Events across arbitrary chunk boundaries.
export function createSseParser(onEvent) {
    let buffer = "";
    let event = "message";
    let data = [];
    let id = "";
    return (text) => {
        buffer += text;
        let newline;
        while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
            const line = buffer.slice(0, newline);
            const separatorLength = buffer.startsWith("\r\n", newline) ? 2 : 1;
            // A trailing "\r" may be the first half of "\r\n"; wait for more input.
            if (buffer[newline] === "\r" && newline + 1 === buffer.length) break;
            buffer = buffer.slice(newline + separatorLength);
            if (line === "") {
                if (data.length > 0) onEvent({ event, data: data.join("\n"), id });
                event = "message";
                data = [];
                id = "";
                continue;
            }
            if (line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? "" : line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);
            if (field === "event") event = value;
            else if (field === "data") data.push(value);
            else if (field === "id") id = value;
        }
    };
}

export class PeerBusClient {
    constructor({
        url,
        token = "",
        name,
        host = os.hostname(),
        platform = process.platform,
        onMessage,
        onStatus = () => {},
        fetchImpl = globalThis.fetch,
        reconnectMinMs = 1000,
        reconnectMaxMs = 30_000,
    }) {
        if (!url) throw new Error("peer-bus relay URL is not configured");
        if (!NAME_PATTERN.test(name ?? "")) throw new Error(`invalid peer name: ${name}`);
        Object.assign(this, { url, token, name, host, platform, onMessage, onStatus, fetchImpl });
        this.reconnectMinMs = reconnectMinMs;
        this.reconnectMaxMs = reconnectMaxMs;
        this.state = "idle";
        this.abort = null;
        this.stopped = false;
        this.done = null;
    }

    headers(extra = {}) {
        return this.token ? { ...extra, Authorization: `Bearer ${this.token}` } : extra;
    }

    setState(state, detail) {
        if (this.state === state && !detail) return;
        this.state = state;
        this.onStatus(state, detail);
    }

    start() {
        this.stopped = false;
        this.done ??= this.run().finally(() => {
            this.done = null;
        });
        return this.done;
    }

    async stop() {
        this.stopped = true;
        this.abort?.abort();
        await this.done;
        this.setState("stopped");
    }

    async run() {
        let delay = this.reconnectMinMs;
        while (!this.stopped) {
            const outcome = await this.connectOnce();
            if (outcome === "connected") delay = this.reconnectMinMs;
            if (outcome === "replaced" || outcome === "unauthorized") {
                this.stopped = true;
                this.setState(outcome);
                return;
            }
            if (this.stopped) return;
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, this.reconnectMaxMs);
        }
    }

    // Resolves "connected" if a stream was established and later ended, otherwise the failure kind.
    async connectOnce() {
        this.abort = new AbortController();
        const query = new URLSearchParams({ name: this.name, host: this.host, platform: this.platform });
        let response;
        try {
            this.setState("connecting");
            response = await this.fetchImpl(`${this.url}/events?${query}`, {
                headers: this.headers({ Accept: "text/event-stream" }),
                signal: this.abort.signal,
            });
        } catch (error) {
            if (!this.stopped) this.setState("disconnected", error.cause?.message ?? error.message);
            return "error";
        }
        if (response.status === 401) return "unauthorized";
        if (!response.ok || !response.body) {
            this.setState("disconnected", `relay returned HTTP ${response.status}`);
            return "error";
        }

        let outcome = "connected";
        const parse = createSseParser(({ event, data }) => {
            if (event === "ready") this.setState("connected");
            else if (event === "replaced") outcome = "replaced";
            else if (event === "message") {
                try {
                    this.onMessage?.(JSON.parse(data));
                } catch (error) {
                    this.onStatus("error", `bad message from relay: ${error.message}`);
                }
            }
        });
        const decoder = new TextDecoder();
        try {
            for await (const chunk of response.body) {
                parse(decoder.decode(chunk, { stream: true }));
                if (outcome === "replaced") break;
            }
        } catch (error) {
            if (!this.stopped) this.setState("disconnected", error.message);
            return outcome;
        }
        if (!this.stopped && outcome !== "replaced") this.setState("disconnected", "relay closed the stream");
        return outcome;
    }

    async request(method, pathname, body) {
        const response = await this.fetchImpl(`${this.url}${pathname}`, {
            method,
            headers: this.headers(body ? { "Content-Type": "application/json" } : {}),
            body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error ?? `relay returned HTTP ${response.status}`);
        return payload;
    }

    send(to, body) {
        return this.request("POST", "/send", { from: this.name, to, body });
    }

    async peers() {
        return (await this.request("GET", "/peers")).peers;
    }
}

export function formatIncoming(message, selfName) {
    return [
        `<peer_message from="${message.from}" to="${message.to}" id="${message.id}" sent_at="${message.sentAt}">`,
        message.body,
        "</peer_message>",
        "",
        `This message was delivered over the peer bus from the Copilot session "${message.from}" to you ("${selfName}").` +
            ` Handle it as a request from a collaborating agent. If a reply is needed, call peer_send with to="${message.from}".` +
            " Do not send replies that are only acknowledgments.",
    ].join("\n");
}
