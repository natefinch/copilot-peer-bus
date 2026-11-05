// Peer-bus relay: routes messages between Copilot sessions over HTTP + Server-Sent Events.
// Dependency-free so it runs anywhere Node 18+ runs (including the provided Docker image).

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BODY_BYTES = 256 * 1024;

export function createRelay({
    token = "",
    queueLimit = 100,
    queueTtlMs = 60 * 60 * 1000,
    heartbeatMs = 15_000,
    log = () => {},
} = {}) {
    const peers = new Map();
    const queues = new Map();
    const tokenDigest = token ? digest(token) : null;

    function authorized(req) {
        if (!tokenDigest) return true;
        const header = req.headers.authorization ?? "";
        const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
        return timingSafeEqual(digest(presented), tokenDigest);
    }

    function writeEvent(res, event, data, id) {
        let frame = `event: ${event}\n`;
        if (id) frame += `id: ${id}\n`;
        frame += `data: ${JSON.stringify(data)}\n\n`;
        return res.write(frame);
    }

    function enqueue(name, message) {
        const now = Date.now();
        const queue = (queues.get(name) ?? []).filter((entry) => entry.expiresAt > now);
        queue.push({ message, expiresAt: now + queueTtlMs });
        while (queue.length > queueLimit) queue.shift();
        queues.set(name, queue);
    }

    function flushQueue(name, res) {
        const queue = queues.get(name);
        if (!queue) return;
        queues.delete(name);
        const now = Date.now();
        for (const entry of queue) {
            if (entry.expiresAt > now) writeEvent(res, "message", entry.message, entry.message.id);
        }
    }

    function handleEvents(req, res, url) {
        const name = url.searchParams.get("name") ?? "";
        if (!NAME_PATTERN.test(name)) return sendJson(res, 400, { error: "invalid name" });

        const existing = peers.get(name);
        if (existing) {
            writeEvent(existing.res, "replaced", { name });
            existing.res.end();
            peers.delete(name);
            log(`peer ${name} replaced by a new connection`);
        }

        req.socket.setTimeout(0);
        req.socket.setNoDelay(true);
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.write("retry: 2000\n\n");

        const peer = {
            res,
            name,
            host: (url.searchParams.get("host") ?? "").slice(0, 128),
            platform: (url.searchParams.get("platform") ?? "").slice(0, 32),
            connectedAt: new Date().toISOString(),
        };
        peers.set(name, peer);
        log(`peer ${name} connected (${peer.host || "unknown host"})`);
        writeEvent(res, "ready", { name });
        flushQueue(name, res);

        const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
        heartbeat.unref();
        res.on("close", () => {
            clearInterval(heartbeat);
            if (peers.get(name) === peer) {
                peers.delete(name);
                log(`peer ${name} disconnected`);
            }
        });
    }

    async function handleSend(req, res) {
        let payload;
        try {
            payload = JSON.parse(await readBody(req));
        } catch (error) {
            return sendJson(res, error.statusCode ?? 400, { error: error.statusCode ? error.message : "invalid JSON" });
        }
        const { from, to, body } = payload ?? {};
        if (typeof from !== "string" || !NAME_PATTERN.test(from)) return sendJson(res, 400, { error: "invalid from" });
        if (typeof to !== "string" || (to !== "*" && !NAME_PATTERN.test(to))) {
            return sendJson(res, 400, { error: "invalid to" });
        }
        if (typeof body !== "string" || body.length === 0) return sendJson(res, 400, { error: "body is required" });

        const message = { id: randomUUID(), from, to, body, sentAt: new Date().toISOString() };
        const delivered = [];
        const queued = [];
        if (to === "*") {
            for (const [name, peer] of peers) {
                if (name === from) continue;
                writeEvent(peer.res, "message", message, message.id);
                delivered.push(name);
            }
        } else if (peers.has(to)) {
            writeEvent(peers.get(to).res, "message", message, message.id);
            delivered.push(to);
        } else {
            enqueue(to, message);
            queued.push(to);
        }
        log(`message ${message.id} ${from} -> ${to}: delivered=[${delivered}] queued=[${queued}]`);
        return sendJson(res, 200, { id: message.id, delivered, queued });
    }

    function handlePeers(res) {
        const list = [...peers.values()].map(({ name, host, platform, connectedAt }) => ({
            name,
            host,
            platform,
            connectedAt,
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        return sendJson(res, 200, { peers: list });
    }

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://relay");
        if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
        if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
        if (req.method === "GET" && url.pathname === "/events") return handleEvents(req, res, url);
        if (req.method === "POST" && url.pathname === "/send") {
            return handleSend(req, res).catch((error) => {
                log(`send failed: ${error.message}`);
                if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
            });
        }
        if (req.method === "GET" && url.pathname === "/peers") return handlePeers(res);
        return sendJson(res, 404, { error: "not found" });
    });

    const closeServer = server.close.bind(server);
    server.close = (callback) => {
        for (const peer of peers.values()) peer.res.end();
        peers.clear();
        return closeServer(callback);
    };
    return server;
}

function digest(value) {
    return createHash("sha256").update(value).digest();
}

function sendJson(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        });
        req.on("end", () => {
            if (size > MAX_BODY_BYTES) reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
            else resolve(Buffer.concat(chunks).toString("utf8"));
        });
        req.on("error", reject);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.env.PORT ?? 7777);
    const host = process.env.HOST ?? "0.0.0.0";
    const token = process.env.PEER_BUS_TOKEN ?? "";
    if (!token) console.warn("PEER_BUS_TOKEN is not set; the relay accepts unauthenticated requests.");
    const server = createRelay({ token, log: (line) => console.log(`${new Date().toISOString()} ${line}`) });
    server.listen(port, host, () => console.log(`peer-bus relay listening on ${host}:${port}`));
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => server.close(() => process.exit(0)));
    }
}
