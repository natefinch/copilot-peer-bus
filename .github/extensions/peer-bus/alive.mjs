// Watches GitHub issues for changes over GitHub Alive and reports which issue changed.
// Alive only signals "something changed"; callers fetch the actual comments.

const SUBSCRIBE_BATCH = 25;

export function channelNamesFromSigned(signed) {
    const [content, signature] = String(signed).split("--");
    if (!content || !signature) return [];
    try {
        const { c } = JSON.parse(Buffer.from(content, "base64").toString("utf8"));
        return (Array.isArray(c) ? c : [c]).filter((name) => typeof name === "string" && name);
    } catch {
        return [];
    }
}

export class AliveWatcher {
    constructor({ github, onSignal, onLiveChange = () => {}, log = () => {}, WebSocketImpl = globalThis.WebSocket }) {
        Object.assign(this, { github, onSignal, onLiveChange, log, WebSocketImpl });
        this.issues = [];
        this.socket = null;
        this.live = false;
        this.stopped = true;
        this.backoffMs = 1000;
        this.reconnectTimer = null;
        this.generation = 0;
    }

    get available() {
        return typeof this.WebSocketImpl === "function";
    }

    setIssues(numbers) {
        const next = [...new Set(numbers.map(Number))].sort((a, b) => a - b);
        if (next.join() === this.issues.join()) return;
        this.issues = next;
        if (!this.stopped) this.reconnect(0);
    }

    start() {
        if (!this.available) {
            this.log("Alive push is unavailable in this runtime (no WebSocket); using polling.");
            return;
        }
        this.stopped = false;
        this.reconnect(0);
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        this.closeSocket();
        this.setLive(false);
    }

    setLive(live) {
        if (this.live === live) return;
        this.live = live;
        this.onLiveChange(live);
    }

    closeSocket() {
        const socket = this.socket;
        this.socket = null;
        this.generation++;
        if (socket) {
            try {
                socket.close();
            } catch {
                // already closed
            }
        }
    }

    reconnect(delayMs) {
        clearTimeout(this.reconnectTimer);
        this.closeSocket();
        this.setLive(false);
        if (this.stopped || this.issues.length === 0) return;
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch((error) => {
                this.log(`Alive connection failed: ${error.message}`);
                this.scheduleRetry();
            });
        }, delayMs);
        this.reconnectTimer.unref?.();
    }

    scheduleRetry() {
        if (this.stopped) return;
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
        this.reconnect(delay);
    }

    async connect() {
        const generation = ++this.generation;
        const signedByIssue = await this.github.issueUpdateChannels(this.issues);
        if (signedByIssue.size === 0) throw new Error("no Alive channels resolved (token may lack Alive access)");
        const issueByName = new Map();
        for (const [number, signed] of signedByIssue) {
            for (const name of channelNamesFromSigned(signed)) issueByName.set(name, number);
        }
        const url = await this.github.aliveSocketUrl();
        if (generation !== this.generation || this.stopped) return;

        const socket = new this.WebSocketImpl(url);
        this.socket = socket;
        const current = () => this.socket === socket;
        socket.onopen = () => {
            if (!current()) return;
            const signed = [...signedByIssue.values()];
            for (let i = 0; i < signed.length; i += SUBSCRIBE_BATCH) {
                const batch = Object.fromEntries(signed.slice(i, i + SUBSCRIBE_BATCH).map((s) => [s, ""]));
                socket.send(JSON.stringify({ subscribe: batch }));
            }
        };
        socket.onmessage = (event) => {
            if (!current()) return;
            let frame;
            try {
                frame = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
            } catch {
                return;
            }
            if (frame.e === "ack") {
                this.backoffMs = 1000;
                this.setLive(true);
            } else if (frame.e === "msg") {
                const number = issueByName.get(frame.ch);
                if (number !== undefined) this.onSignal(number);
            }
        };
        socket.onclose = (event) => {
            if (!current()) return;
            this.log(`Alive socket closed (code ${event?.code ?? "?"}${event?.reason ? `, ${event.reason}` : ""})`);
            this.socket = null;
            this.setLive(false);
            this.scheduleRetry();
        };
        socket.onerror = () => {
            // onclose follows and schedules the retry
        };
    }
}
