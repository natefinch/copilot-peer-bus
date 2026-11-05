// Peer-bus core: channels and inboxes are GitHub issues, messages are comments, Alive pushes changes.

import { AliveWatcher } from "./alive.mjs";
import {
    channelTitle,
    encodeMessage,
    encodePresence,
    formatAddress,
    formatPrompt,
    inboxTitle,
    isAddressedTo,
    parseAddress,
    parseComment,
    parseTitle,
    sameLogin,
    sameSession,
    senderAddress,
    validateChannelName,
    validateSessionName,
} from "./protocol.mjs";

const MAX_CATCH_UP = 20;
const CHANNEL_BODY = "Peer-bus channel. Copilot sessions post messages here as comments. Humans can comment too.";
const INBOX_BODY = "Peer-bus inbox. Direct messages to this person's Copilot sessions are posted here as comments.";

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class PeerBus {
    constructor({
        github,
        store,
        sid,
        host = "",
        platform = "",
        deliver,
        notify,
        log = () => {},
        createAlive = (options) => new AliveWatcher(options),
        pollMs = 60_000,
        fallbackPollMs = 10_000,
        presenceMs = 5 * 60_000,
        staleMs = 15 * 60_000,
        directoryTtlMs = 30_000,
        now = () => Date.now(),
    }) {
        Object.assign(this, { github, store, sid, host, platform, deliver, notify, log, createAlive });
        Object.assign(this, { pollMs, fallbackPollMs, presenceMs, staleMs, directoryTtlMs, now });
        this.state = null;
        this.me = null;
        this.inbox = null;
        this.sources = new Map();
        this.fetchers = new Map();
        this.dir = null;
        this.alive = null;
        this.timers = [];
        this.retryMs = 30_000;
        this.stopped = false;
    }

    get joined() {
        return Boolean(this.me);
    }

    // Restores a previously joined session (after a restart or /clear).
    async start() {
        const saved = this.store.load();
        if (!saved?.name || saved.repo !== this.github.repo) return false;
        this.state = { channels: [], trusted: [], cursors: {}, presenceCommentId: null, isDefault: false, ...saved };
        await this.connectWithRetry();
        return true;
    }

    async connectWithRetry() {
        try {
            await this.connect();
            this.retryMs = 30_000;
        } catch (error) {
            this.log(`could not connect as "${this.state?.name}": ${error.message}; retrying in ${this.retryMs / 1000}s`, "warning");
            this.addTimer(setTimeout(() => this.connectWithRetry(), this.retryMs));
            this.retryMs = Math.min(this.retryMs * 2, 5 * 60_000);
        }
    }

    stop() {
        this.stopped = true;
        this.clearTimers();
        this.alive?.stop();
    }

    onAliveLiveChange(live) {
        if (this.stopped || !this.me) return;
        this.log(live ? "Alive push connected" : "Alive push disconnected; polling until it reconnects");
        if (live) this.fetchAll();
        this.schedulePoll();
    }

    // --- tools -----------------------------------------------------------------------------

    async join({ name, isDefault = false }) {
        validateSessionName(name);
        const login = await this.github.login();
        const inbox = await this.ensureInbox(login);
        const comments = await this.github.listComments(inbox.number);
        for (const comment of comments) {
            const presence = parseComment(comment, []);
            if (presence.type !== "presence" || !sameLogin(presence.author, login)) continue;
            const fresh = this.isFresh(presence);
            const mine = presence.sid === this.sid;
            if (fresh && !mine && sameSession(presence.session, name)) {
                throw new Error(`Another session is already on the peer bus as "${login}/${presence.session}" (host ${presence.host || "?"}). Pick a different name.`);
            }
            const keep = mine && comment.id === this.state?.presenceCommentId;
            if (!fresh || (mine && !keep)) await this.github.deleteComment(comment.id).catch(() => {});
        }
        const previous = this.state?.repo === this.github.repo ? this.state : null;
        this.state = {
            repo: this.github.repo,
            name,
            isDefault: Boolean(isDefault),
            channels: previous?.channels ?? [],
            trusted: previous?.trusted ?? [],
            cursors: previous?.cursors ?? {},
            presenceCommentId: previous?.presenceCommentId ?? null,
        };
        this.save();
        await this.connect();
        return { login, inboxUrl: inbox.html_url };
    }

    async leave() {
        if (!this.state) return null;
        const name = this.me ? `${this.me.login}/${this.state.name}` : this.state.name;
        this.me = null;
        this.clearTimers();
        this.alive?.stop();
        if (this.state.presenceCommentId) await this.github.deleteComment(this.state.presenceCommentId).catch(() => {});
        this.store.clear();
        this.state = null;
        this.sources.clear();
        return name;
    }

    async joinChannel(channel) {
        this.requireJoined();
        validateChannelName(channel);
        if (this.state.channels.includes(channel)) return { url: this.sourceForChannel(channel)?.url, created: false, already: true };
        const dir = await this.directory(true);
        let issue = dir.channels.get(channel);
        const created = !issue;
        issue ??= await this.createIssue(channelTitle(channel), CHANNEL_BODY, (d) => d.channels.get(channel));
        this.state.channels.push(channel);
        await this.addSource(issue, channel);
        this.save();
        this.alive?.setIssues([...this.sources.keys()]);
        await this.upsertPresence();
        return { url: issue.html_url, created, already: false };
    }

    async leaveChannel(channel) {
        this.requireJoined();
        if (!this.state.channels.includes(channel)) return false;
        this.state.channels = this.state.channels.filter((c) => c !== channel);
        const source = this.sourceForChannel(channel);
        if (source) {
            this.sources.delete(source.number);
            delete this.state.cursors[source.number];
        }
        this.save();
        this.alive?.setIssues([...this.sources.keys()]);
        await this.upsertPresence();
        return true;
    }

    async send({ to, message, channel, kind = "task" }) {
        this.requireJoined();
        const body = String(message ?? "").trim();
        if (!body) throw new Error("Message is empty.");
        if (kind !== "task" && kind !== "notify") throw new Error(`Unknown kind "${kind}". Use "task" or "notify".`);
        const addresses = (Array.isArray(to) ? to : String(to ?? "").split(",")).filter((a) => String(a).trim()).map(parseAddress);
        if (addresses.length === 0) throw new Error("No recipients.");
        for (const address of addresses) {
            if (address.kind === "session" && sameLogin(address.login, this.me.login) && sameSession(address.session, this.me.session)) {
                throw new Error("Cannot send a message to this session itself.");
            }
        }

        let issue;
        if (channel) {
            validateChannelName(channel);
            issue = (await this.directory()).channels.get(channel) ?? (await this.directory(true)).channels.get(channel);
            if (!issue) throw new Error(`Channel #${channel} doesn't exist. Create it with peer_channel_join.`);
        } else {
            if (addresses.some((a) => a.kind === "all")) throw new Error('"*" needs a channel.');
            const logins = new Set(addresses.map((a) => a.login.toLowerCase()));
            if (logins.size > 1) throw new Error("A direct message goes to one person's inbox. Send separate messages, or use a channel.");
            issue = await this.inboxFor(addresses[0].login);
            if (!issue) throw new Error(`${addresses[0].login} hasn't joined the peer bus yet (no inbox in ${this.github.repo}).`);
        }

        const comment = await this.github.createComment(
            issue.number,
            encodeMessage({ login: this.me.login, from: this.me.session, to: addresses, kind, body })
        );
        await this.mute(issue.node_id);
        const notes = await this.recipientNotes(addresses).catch(() => []);
        return { url: comment.html_url, notes };
    }

    async list({ channel } = {}) {
        if (channel) validateChannelName(channel);
        const dir = await this.directory(true);
        const sessions = [];
        for (const inbox of dir.inboxes.values()) {
            for (const presence of await this.presences(inbox)) {
                if (!presence.fresh) continue;
                if (channel && !presence.channels.includes(channel)) continue;
                sessions.push({ ...presence, login: inbox.login });
            }
        }
        sessions.sort((a, b) => `${a.login}/${a.session}`.localeCompare(`${b.login}/${b.session}`));
        return { channels: [...dir.channels.keys()].sort(), sessions };
    }

    trust(login, trusted) {
        this.requireJoined();
        const address = parseAddress(login);
        if (address.kind !== "person") throw new Error(`Trust applies to a GitHub login, not "${login}".`);
        const others = this.state.trusted.filter((l) => !sameLogin(l, address.login));
        this.state.trusted = trusted ? [...others, address.login] : others;
        this.save();
        return this.state.trusted;
    }

    status() {
        if (!this.me) return null;
        return {
            address: `${this.me.login}/${this.me.session}`,
            isDefault: this.me.isDefault,
            channels: [...this.state.channels],
            trusted: [...this.state.trusted],
            push: this.alive?.live ? "live" : "polling",
            inboxUrl: this.inbox?.html_url,
        };
    }

    // --- connection ------------------------------------------------------------------------

    async connect() {
        this.clearTimers();
        this.stopped = false;
        const login = await this.github.login();
        this.me = { login, session: this.state.name, isDefault: this.state.isDefault };
        this.inbox = await this.ensureInbox(login);
        this.sources.clear();
        await this.addSource(this.inbox, null);
        const dir = await this.directory(true);
        for (const channel of this.state.channels) {
            const issue = dir.channels.get(channel) ?? (await this.createIssue(channelTitle(channel), CHANNEL_BODY, (d) => d.channels.get(channel)));
            await this.addSource(issue, channel);
        }
        this.save();
        await this.upsertPresence();

        if (!this.alive) {
            this.alive = this.createAlive({
                github: this.github,
                onSignal: (number) => this.fetchSource(number),
                onLiveChange: (live) => this.onAliveLiveChange(live),
                log: (text) => this.log(text),
            });
        }
        this.alive.setIssues([...this.sources.keys()]);
        this.alive.start();
        this.addTimer(setInterval(() => this.upsertPresence().catch((e) => this.log(`presence update failed: ${e.message}`)), this.presenceMs));
        this.schedulePoll();
        await this.fetchAll();
    }

    schedulePoll() {
        clearTimeout(this.pollTimer);
        if (!this.me || this.stopped) return;
        this.pollTimer = setTimeout(async () => {
            await this.fetchAll();
            this.schedulePoll();
        }, this.alive?.live ? this.pollMs : this.fallbackPollMs);
        this.pollTimer.unref?.();
    }

    addTimer(timer) {
        timer.unref?.();
        this.timers.push(timer);
    }

    clearTimers() {
        for (const timer of this.timers) {
            clearTimeout(timer);
            clearInterval(timer);
        }
        this.timers = [];
        clearTimeout(this.pollTimer);
    }

    save() {
        if (this.state) this.store.save(this.state);
    }

    requireJoined() {
        if (!this.me) throw new Error("This session hasn't joined the peer bus. Call peer_join first.");
    }

    isFresh(presence) {
        return this.now() - Date.parse(presence.updatedAt) < this.staleMs;
    }

    // --- directory -------------------------------------------------------------------------

    async directory(force = false) {
        if (!force && this.dir && this.now() - this.dir.at < this.directoryTtlMs) return this.dir;
        const channels = new Map();
        const inboxes = new Map();
        const issues = (await this.github.listOpenIssues()).sort((a, b) => a.number - b.number);
        for (const issue of issues) {
            const parsed = parseTitle(issue.title);
            const entry = { number: issue.number, node_id: issue.node_id, html_url: issue.html_url };
            if (parsed?.type === "channel" && !channels.has(parsed.name)) {
                channels.set(parsed.name, { ...entry, channel: parsed.name });
            } else if (parsed?.type === "inbox" && sameLogin(issue.user?.login, parsed.login)) {
                const key = parsed.login.toLowerCase();
                if (!inboxes.has(key)) inboxes.set(key, { ...entry, login: issue.user.login });
            }
        }
        this.dir = { at: this.now(), channels, inboxes };
        return this.dir;
    }

    async inboxFor(login) {
        const key = login.toLowerCase();
        return (await this.directory()).inboxes.get(key) ?? (await this.directory(true)).inboxes.get(key) ?? null;
    }

    async ensureInbox(login) {
        return (await this.inboxFor(login)) ?? this.createIssue(inboxTitle(login), INBOX_BODY, (d) => d.inboxes.get(login.toLowerCase()));
    }

    // Creates an issue, then returns the directory's winner in case another session raced us.
    async createIssue(title, body, pick) {
        const created = await this.github.createIssue(title, body);
        await this.mute(created.node_id);
        const winner = pick(await this.directory(true));
        if (winner && winner.number !== created.number) {
            await this.github.closeIssue(created.number).catch(() => {});
            return winner;
        }
        return winner ?? { number: created.number, node_id: created.node_id, html_url: created.html_url };
    }

    async presences(inbox) {
        const since = new Date(this.now() - this.staleMs - 60_000).toISOString();
        const result = [];
        for (const comment of await this.github.listComments(inbox.number, since)) {
            const presence = parseComment(comment, []);
            if (presence.type === "presence" && sameLogin(presence.author, inbox.login)) {
                result.push({ ...presence, fresh: this.isFresh(presence) });
            }
        }
        return result;
    }

    async upsertPresence() {
        if (!this.me) return;
        const body = encodePresence({
            login: this.me.login,
            session: this.state.name,
            sid: this.sid,
            host: this.host,
            platform: this.platform,
            channels: this.state.channels,
            isDefault: this.state.isDefault,
        });
        if (this.state.presenceCommentId) {
            try {
                await this.github.updateComment(this.state.presenceCommentId, body);
                return;
            } catch (error) {
                if (error.status !== 404) throw error;
            }
        }
        const comment = await this.github.createComment(this.inbox.number, body);
        this.state.presenceCommentId = comment.id;
        this.save();
        await this.mute(this.inbox.node_id);
    }

    // Unsubscribes this user from an issue thread so bus traffic doesn't flood their notifications.
    async mute(nodeId) {
        if (this.muteUnavailable) return;
        if (this.github.scopes && !this.github.scopes.has("notifications")) {
            this.muteUnavailable = true;
            return;
        }
        try {
            await this.github.unsubscribeThread(nodeId);
        } catch (error) {
            if (/scope/i.test(error.message)) this.muteUnavailable = true;
            else this.log(`could not mute an issue thread: ${error.message}`);
        }
    }

    notificationHint() {
        const missing = this.muteUnavailable || (this.github.scopes && !this.github.scopes.has("notifications"));
        return missing
            ? "Your GitHub token lacks the notifications scope, so the bus can't mute the issue threads it posts in, and other people's " +
                  "messages in those threads may notify you. Run `gh auth refresh -h github.com -s notifications` to fix this."
            : null;
    }

    async recipientNotes(addresses) {
        const notes = [];
        for (const address of addresses) {
            if (address.kind === "all") continue;
            const inbox = await this.inboxFor(address.login);
            const online = inbox ? (await this.presences(inbox)).filter((p) => p.fresh) : [];
            if (address.kind === "session" && !online.some((p) => sameSession(p.session, address.session))) {
                notes.push(`${formatAddress(address)} isn't online; it will get the message when it reconnects.`);
            } else if (address.kind === "person" && !online.some((p) => p.isDefault)) {
                notes.push(`${address.login} has no default session online; GitHub will notify them through the @mention.`);
            }
        }
        return notes;
    }

    // --- receiving -------------------------------------------------------------------------

    sourceForChannel(channel) {
        return [...this.sources.values()].find((s) => s.channel === channel);
    }

    async addSource(issue, channel) {
        this.sources.set(issue.number, { number: issue.number, channel, url: issue.html_url, node_id: issue.node_id });
        if (!this.state.cursors[issue.number]) {
            const latest = await this.github.latestComment(issue.number);
            this.state.cursors[issue.number] = latest ? { id: latest.id, createdAt: latest.created_at } : { id: 0, createdAt: null };
        }
    }

    fetchAll() {
        return Promise.all([...this.sources.keys()].map((number) => this.fetchSource(number)));
    }

    // Serializes fetches per issue and coalesces signals that arrive while one is queued.
    fetchSource(number) {
        const entry = this.fetchers.get(number) ?? { chain: Promise.resolve(), queued: null };
        this.fetchers.set(number, entry);
        if (entry.queued) return entry.queued;
        const run = entry.chain.then(() => {
            entry.queued = null;
            return this.fetchSourceNow(number);
        });
        entry.queued = run.catch((error) => this.log(`fetching #${number} failed: ${error.message}`, "warning"));
        entry.chain = entry.queued;
        return entry.queued;
    }

    async fetchSourceNow(number) {
        const source = this.sources.get(number);
        if (!source || !this.me) return;
        const cursor = this.state.cursors[number] ?? { id: 0, createdAt: null };
        const comments = await this.github.listComments(number, cursor.createdAt);
        const fresh = comments.filter((c) => c.id > cursor.id).sort((a, b) => a.id - b.id);
        if (fresh.length === 0 || !this.sources.has(number)) return;
        const last = fresh.at(-1);
        this.state.cursors[number] = { id: last.id, createdAt: last.created_at };
        this.save();

        const defaultTo = source.channel ? [{ kind: "all" }] : [{ kind: "person", login: this.me.login }];
        const where = source.channel ? `#${source.channel}` : "direct";
        const incoming = [];
        for (const comment of fresh) {
            const message = parseComment(comment, defaultTo);
            if (message.type === "presence" || !message.body) continue;
            if (!isAddressedTo(message, this.me)) continue;
            incoming.push({ ...message, channel: source.channel, where });
        }
        this.dispatch(incoming);
    }

    dispatch(incoming) {
        const tasks = [];
        const notes = [];
        for (const message of incoming) {
            const trusted = sameLogin(message.author, this.me.login) || this.state.trusted.some((l) => sameLogin(l, message.author));
            if (message.kind === "task" && trusted) tasks.push(message);
            else notes.push({ message, untrustedTask: message.kind === "task" });
        }
        const shownNotes = notes.slice(-MAX_CATCH_UP);
        if (notes.length > shownNotes.length) this.notify(`📨 ${notes.length - shownNotes.length} older peer notification(s) skipped.`);
        for (const { message, untrustedTask } of shownNotes) {
            const suffix = untrustedTask
                ? ` (not given to the agent: ${message.author} isn't trusted in this session; use peer_trust to allow)`
                : "";
            this.notify(`📨 ${senderAddress(message)} (${message.where}): ${truncate(message.body, 400)} ${message.url}${suffix}`);
        }
        if (tasks.length > 0) {
            const shown = tasks.slice(-MAX_CATCH_UP);
            this.deliver(formatPrompt(shown, this.me, { omitted: tasks.length - shown.length }));
        }
    }
}
