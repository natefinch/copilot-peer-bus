// Peer-bus core: channels and inboxes are GitHub issues, messages are comments, Alive pushes changes.
// A channel is any issue, referenced by its URL and identified internally by "owner/repo#123".

import { AliveWatcher } from "./alive.mjs";
import {
    REPO,
    describeChannel,
    encodeMessage,
    encodePresence,
    formatAddress,
    formatPrompt,
    inboxTitle,
    isAddressedTo,
    issueKey,
    issueUrl,
    parseAddress,
    parseChannel,
    parseComment,
    parseTitle,
    sameLogin,
    sameSession,
    senderAddress,
    validateRepo,
    validateSessionName,
} from "./protocol.mjs";

const MAX_CATCH_UP = 20;
const INBOX_BODY = "Peer-bus inbox. Direct messages to this person's Copilot sessions are posted here as comments.";
const ABOUT = /^(https:\/\/github\.com\/\S+|[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#\d+)$/;

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const repoFromUrl = (url) => /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/.exec(url ?? "")?.[1];
const isChannelEntry = (c) => c && typeof c === "object" && REPO.test(c.repo ?? "") && Number.isInteger(c.number) && c.number > 0;

function channelBody(about) {
    const lines = [
        "**Peer-bus channel.** Copilot sessions coordinate here by posting comments; people can comment too.",
        "To add a session, give it this issue's URL and ask it to join the channel (`peer_channel_join`).",
    ];
    if (about) lines.push("", `Related: ${about}`);
    return lines.join("\n");
}

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
        this.state = { trusted: [], cursors: {}, presenceCommentId: null, isDefault: false, ...saved };
        this.state.channels = Array.isArray(saved.channels) ? saved.channels.filter(isChannelEntry) : [];
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
        for (const comment of await this.github.listComments(inbox)) {
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

    // channel: the channel issue's URL.
    async joinChannel(channel) {
        this.requireJoined();
        const issue = await this.resolveChannel(channel);
        const key = issueKey(issue);
        const existing = this.state.channels.find((c) => issueKey(c) === key);
        if (existing) return { ...issue, label: describeChannel(existing), already: true };
        const entry = { repo: issue.repo, number: issue.number, title: issue.title };
        await this.addSource(issue, entry);
        this.state.channels.push(entry);
        this.save();
        this.alive?.setIssues(this.sourceRefs());
        await this.upsertPresence();
        return { ...issue, label: describeChannel(entry), already: false };
    }

    // Creates a new issue to serve as a channel (in the bus repo unless `repo` is given) and joins it.
    async createChannel({ title, repo, about }) {
        this.requireJoined();
        const target = repo ? validateRepo(repo) : this.github.repo;
        const text = String(title ?? "").trim();
        if (!text) throw new Error("A channel needs a title.");
        if (parseTitle(text)) throw new Error("That title is reserved for the bus's inboxes.");
        const related = about ? String(about).trim() : "";
        if (related && !ABOUT.test(related)) throw new Error(`"${about}" isn't an issue or pull request reference. Use a github.com URL or owner/repo#123.`);
        let created;
        try {
            created = await this.github.createIssue(text, channelBody(related), target);
        } catch (error) {
            if ([403, 404, 410].includes(error.status)) {
                throw new Error(`Can't create an issue in ${target}: you need access to it and issues must be enabled. (${error.message})`);
            }
            throw error;
        }
        await this.mute(created.node_id);
        const joined = await this.joinChannel(created.html_url);
        return { ...joined, inBusRepo: target.toLowerCase() === this.github.repo.toLowerCase() };
    }

    async leaveChannel(channel) {
        this.requireJoined();
        const parsedKey = issueKey(parseChannel(channel));
        const entry = this.state.channels.find((c) => issueKey(c) === parsedKey);
        if (!entry) return null;
        const key = issueKey(entry);
        this.state.channels = this.state.channels.filter((c) => issueKey(c) !== key);
        this.sources.delete(key);
        delete this.state.cursors[key];
        this.save();
        this.alive?.setIssues(this.sourceRefs());
        await this.upsertPresence();
        return describeChannel(entry);
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

        let target;
        if (channel) {
            target = await this.resolveChannel(channel);
        } else {
            if (addresses.some((a) => a.kind === "all")) throw new Error('"*" needs a channel.');
            const logins = new Set(addresses.map((a) => a.login.toLowerCase()));
            if (logins.size > 1) throw new Error("A direct message goes to one person's inbox. Send separate messages, or use a channel.");
            target = await this.inboxFor(addresses[0].login);
            if (!target) throw new Error(`${addresses[0].login} hasn't joined the peer bus yet (no inbox in ${this.github.repo}).`);
        }

        const comment = await this.github.createComment(
            target,
            encodeMessage({ login: this.me.login, from: this.me.session, to: addresses, kind, body })
        );
        await this.mute(target.node_id);
        const notes = await this.recipientNotes(addresses).catch(() => []);
        return { url: comment.html_url, notes };
    }

    async list({ channel } = {}) {
        const filterKey = channel ? issueKey(parseChannel(channel)) : null;
        const dir = await this.directory(true);
        const channels = new Map();
        const sessions = [];
        for (const inbox of dir.inboxes.values()) {
            for (const presence of await this.presences(inbox)) {
                if (!presence.fresh) continue;
                for (const c of presence.channels) {
                    const [repo, number] = c.id.split("#");
                    const known = channels.get(c.id) ?? { id: c.id, label: describeChannel({ repo, number, title: c.title }), online: 0 };
                    known.online++;
                    channels.set(c.id, known);
                }
                if (filterKey && !presence.channels.some((c) => c.id === filterKey)) continue;
                sessions.push({ ...presence, login: inbox.login });
            }
        }
        sessions.sort((a, b) => `${a.login}/${a.session}`.localeCompare(`${b.login}/${b.session}`));
        return { channels: [...channels.values()].sort((a, b) => a.id.localeCompare(b.id)), sessions };
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
            channels: this.state.channels.map(describeChannel),
            trusted: [...this.state.trusted],
            push: this.alive?.live ? "live" : "polling",
            inboxUrl: this.inbox?.html_url,
        };
    }

    // --- channels ---------------------------------------------------------------------------

    // Returns { repo, number, title, html_url, node_id, state }.
    async resolveChannel(channel) {
        const parsed = parseChannel(channel);
        const joined = this.sources.get(issueKey(parsed));
        if (joined?.channel) return joined.issue;
        let issue;
        try {
            issue = await this.github.getIssue(parsed);
        } catch (error) {
            if ([401, 403, 404, 410].includes(error.status)) {
                throw new Error(`Can't access ${parsed.repo}#${parsed.number}. Check the link, and that you have access to ${parsed.repo}.`);
            }
            throw error;
        }
        if (issue.pull_request) {
            throw new Error(`${parsed.repo}#${parsed.number} is a pull request. Create an issue for the channel with peer_channel_create and link the pull request.`);
        }
        if (parseTitle(issue.title)?.type === "inbox") throw new Error("That's a personal inbox, not a channel. Message its owner with peer_send and no channel.");
        return {
            repo: repoFromUrl(issue.html_url) ?? parsed.repo,
            number: issue.number,
            title: issue.title,
            html_url: issue.html_url,
            node_id: issue.node_id,
            state: issue.state,
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
        for (const entry of this.state.channels) {
            try {
                const issue = await this.resolveChannel(issueUrl(entry));
                entry.title = issue.title;
                await this.addSource(issue, entry);
            } catch (error) {
                this.log(`skipping channel ${describeChannel(entry)}: ${error.message}`, "warning");
            }
        }
        this.save();
        await this.upsertPresence();

        if (!this.alive) {
            this.alive = this.createAlive({
                github: this.github,
                onSignal: (key) => this.fetchSource(key),
                onLiveChange: (live) => this.onAliveLiveChange(live),
                log: (text) => this.log(text),
            });
        }
        this.alive.setIssues(this.sourceRefs());
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

    // --- bus repo inboxes -------------------------------------------------------------------

    async directory(force = false) {
        if (!force && this.dir && this.now() - this.dir.at < this.directoryTtlMs) return this.dir;
        const inboxes = new Map();
        const issues = (await this.github.listOpenIssues()).sort((a, b) => a.number - b.number);
        for (const issue of issues) {
            const parsed = parseTitle(issue.title);
            if (parsed?.type !== "inbox" || !sameLogin(issue.user?.login, parsed.login)) continue;
            const key = parsed.login.toLowerCase();
            if (!inboxes.has(key)) {
                inboxes.set(key, { repo: this.github.repo, number: issue.number, node_id: issue.node_id, html_url: issue.html_url, login: issue.user.login });
            }
        }
        this.dir = { at: this.now(), inboxes };
        return this.dir;
    }

    async inboxFor(login) {
        const key = login.toLowerCase();
        return (await this.directory()).inboxes.get(key) ?? (await this.directory(true)).inboxes.get(key) ?? null;
    }

    async ensureInbox(login) {
        return (await this.inboxFor(login)) ?? this.createBusIssue(inboxTitle(login), INBOX_BODY, (d) => d.inboxes.get(login.toLowerCase()));
    }

    // Creates a bus-repo issue, then returns the directory's winner in case another session raced us.
    async createBusIssue(title, body, pick) {
        const created = await this.github.createIssue(title, body);
        await this.mute(created.node_id);
        const winner = pick(await this.directory(true));
        if (winner && winner.number !== created.number) {
            await this.github.closeIssue({ repo: this.github.repo, number: created.number }).catch(() => {});
            return winner;
        }
        return winner ?? { repo: this.github.repo, number: created.number, node_id: created.node_id, html_url: created.html_url };
    }

    async presences(inbox) {
        const since = new Date(this.now() - this.staleMs - 60_000).toISOString();
        const result = [];
        for (const comment of await this.github.listComments(inbox, since)) {
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
            channels: this.state.channels.map((c) => ({ id: issueKey(c), title: truncate(c.title ?? "", 200) })),
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
        const comment = await this.github.createComment(this.inbox, body);
        this.state.presenceCommentId = comment.id;
        this.save();
        await this.mute(this.inbox.node_id);
    }

    // Unsubscribes this user from an issue thread so bus traffic doesn't flood their notifications.
    async mute(nodeId) {
        if (this.muteUnavailable || !nodeId) return;
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

    sourceRefs() {
        return [...this.sources.values()].map((source) => source.ref);
    }

    // issue: { repo, number, html_url, node_id, ... }; channel: the joined channel entry, or null for the inbox.
    async addSource(issue, channel) {
        const ref = { repo: issue.repo, number: issue.number };
        const key = issueKey(ref);
        this.sources.set(key, { key, ref, channel, issue, url: issue.html_url, node_id: issue.node_id });
        if (!this.state.cursors[key]) {
            const latest = await this.github.latestComment(ref);
            this.state.cursors[key] = latest ? { id: latest.id, createdAt: latest.created_at } : { id: 0, createdAt: null };
        }
    }

    fetchAll() {
        return Promise.all([...this.sources.keys()].map((key) => this.fetchSource(key)));
    }

    // Serializes fetches per issue and coalesces signals that arrive while one is queued.
    fetchSource(key) {
        const entry = this.fetchers.get(key) ?? { chain: Promise.resolve(), queued: null };
        this.fetchers.set(key, entry);
        if (entry.queued) return entry.queued;
        const run = entry.chain.then(() => {
            entry.queued = null;
            return this.fetchSourceNow(key);
        });
        entry.queued = run.catch((error) => this.log(`fetching ${key} failed: ${error.message}`, "warning"));
        entry.chain = entry.queued;
        return entry.queued;
    }

    async fetchSourceNow(key) {
        const source = this.sources.get(key);
        if (!source || !this.me) return;
        const cursor = this.state.cursors[key] ?? { id: 0, createdAt: null };
        const comments = await this.github.listComments(source.ref, cursor.createdAt);
        const fresh = comments.filter((c) => c.id > cursor.id).sort((a, b) => a.id - b.id);
        if (fresh.length === 0 || !this.sources.has(key)) return;
        const last = fresh.at(-1);
        this.state.cursors[key] = { id: last.id, createdAt: last.created_at };
        this.save();

        const defaultTo = source.channel ? [{ kind: "all" }] : [{ kind: "person", login: this.me.login }];
        const where = source.channel ? describeChannel(source.channel) : "direct";
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
