// Peer-bus core. A channel is a GitHub issue; messages are new comments on it, each session keeps a
// status-heartbeat comment there, and GitHub Alive pushes changes. See the Schema section of README.md.

import { AliveWatcher } from "./alive.mjs";
import {
    COMMENT_URL,
    MAX_COMMENT_LENGTH,
    MESSAGE_ID,
    acknowledgers,
    describeChannel,
    encodeMessage,
    encodeExit,
    encodeHeartbeat,
    formatHistory,
    formatPrompt,
    isAddressedTo,
    issueKey,
    issueUrl,
    newMessageId,
    parseAddress,
    parseChannel,
    parseComment,
    sameLogin,
    sameSession,
    senderAddress,
    shouldAcknowledge,
    validateRepo,
    validateSessionName,
} from "./protocol.mjs";

const STATE_VERSION = 2;
const MAX_CATCH_UP = 20;
const MAX_INDEXED_MESSAGES = 1000;
const MAX_PENDING_RECEIPTS = 50;
const RECEIPT_TTL_MS = 24 * 60 * 60_000;
const ABOUT = /^(https:\/\/github\.com\/\S+|[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#\d+)$/;
export const MUTE_HELP =
    "The peer bus mutes each channel issue so bus messages don't send GitHub notifications, which needs the GitHub CLI's " +
    "notifications scope. Run `gh auth refresh -h github.com -s notifications` in a terminal where GH_TOKEN and " +
    "GITHUB_TOKEN aren't set (gh won't refresh while they are), then try again.";

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const repoFromUrl = (url) => /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/.exec(url ?? "")?.[1];
const isChannelEntry = (c) => c && typeof c === "object" && typeof c.repo === "string" && Number.isInteger(c.number) && c.number > 0;
const isScopeError = (error) => error?.status === 403 || /scope/i.test(error?.message ?? "");

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
        deliver,
        notify,
        log = () => {},
        createAlive = (options) => new AliveWatcher(options),
        pollMs = 60_000,
        fallbackPollMs = 10_000,
        heartbeatMs = 5 * 60_000,
        staleMs = 15 * 60_000,
        now = () => Date.now(),
    }) {
        Object.assign(this, { github, store, deliver, notify, log, createAlive });
        Object.assign(this, { pollMs, fallbackPollMs, heartbeatMs, staleMs, now });
        this.state = null;
        this.me = null;
        this.sources = new Map();
        this.fetchers = new Map();
        this.messageIndex = new Map();
        this.receipts = new Map();
        this.alive = null;
        this.timers = [];
        this.retryMs = 30_000;
        this.stopped = false;
    }

    get joined() {
        return Boolean(this.me);
    }

    get address() {
        return this.me ? `${this.me.login}/${this.me.session}` : null;
    }

    // Restores a previously joined session (after a restart or /clear).
    async start() {
        const saved = this.store.load();
        if (!saved) return false;
        if (saved.version !== STATE_VERSION || !saved.name) {
            this.store.clear();
            return false;
        }
        this.state = { trusted: [], cursors: {}, ...saved, channels: Array.isArray(saved.channels) ? saved.channels.filter(isChannelEntry) : [] };
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

    // Sets (or changes) this session's name. Renaming replaces its heartbeat comments in every channel.
    async join({ name }) {
        validateSessionName(name);
        const login = await this.github.login();
        if (this.state && this.state.name !== name) {
            for (const entry of this.state.channels) await this.checkNameFree(entry, login, name);
            for (const entry of this.state.channels) await this.deleteStatus(entry);
            this.state.name = name;
        }
        this.state ??= { version: STATE_VERSION, name, trusted: [], cursors: {}, channels: [] };
        this.save();
        await this.connect();
        return { login, address: this.address };
    }

    async leave() {
        if (!this.state) return null;
        const name = this.address ?? this.state.name;
        this.clearTimers();
        this.alive?.stop();
        if (this.me) for (const entry of this.state.channels) await this.postExit(entry);
        this.me = null;
        for (const entry of this.state.channels) await this.deleteStatus(entry);
        this.store.clear();
        this.state = null;
        this.sources.clear();
        return name;
    }

    async joinChannel(channel) {
        this.requireJoined();
        const issue = await this.resolveChannel(channel);
        const key = issueKey(issue);
        const existing = this.state.channels.find((c) => issueKey(c) === key);
        if (existing) return { ...issue, label: describeChannel(existing), already: true };
        if (issue.state === "closed") throw new Error(`${describeChannel(issue)} is closed. Reopen the issue to use it as a channel.`);
        await this.mute(issue.node_id, { required: true });
        await this.checkNameFree(issue, this.me.login, this.me.session);
        const entry = { repo: issue.repo, number: issue.number, title: issue.title, nodeId: issue.node_id, statusCommentId: null, heartReactionId: null };
        await this.addSource(issue, entry);
        this.state.channels.push(entry);
        this.save();
        await this.ensureStatus(entry);
        this.alive?.setIssues(this.sourceRefs());
        return { ...issue, label: describeChannel(entry), already: false };
    }

    // Creates a new issue to serve as a channel and joins it.
    async createChannel({ title, repo, about }) {
        this.requireJoined();
        validateRepo(repo);
        const text = String(title ?? "").trim();
        if (!text) throw new Error("A channel needs a title.");
        const related = about ? String(about).trim() : "";
        if (related && !ABOUT.test(related)) throw new Error(`"${about}" isn't an issue or pull request reference. Use a github.com URL or owner/repo#123.`);
        await this.requireMuteScope();
        let created;
        try {
            created = await this.github.createIssue(text, channelBody(related), repo);
        } catch (error) {
            if ([403, 404, 410].includes(error.status)) {
                throw new Error(`Can't create an issue in ${repo}: you need access to it and issues must be enabled. (${error.message})`);
            }
            throw error;
        }
        await this.mute(created.node_id, { required: true });
        return this.joinChannel(created.html_url);
    }

    async leaveChannel(channel) {
        this.requireJoined();
        const key = issueKey(parseChannel(channel));
        const entry = this.state.channels.find((c) => issueKey(c) === key);
        if (!entry) return null;
        await this.dropChannel(entry, { announce: true });
        return describeChannel(entry);
    }

    // Stops listening in a channel: optionally posts an exit_channel message, then deletes the heartbeat comment.
    async dropChannel(entry, { announce }) {
        const key = issueKey(entry);
        if (announce) await this.postExit(entry);
        await this.deleteStatus(entry);
        this.state.channels = this.state.channels.filter((c) => issueKey(c) !== key);
        this.sources.delete(key);
        this.messageIndex.delete(key);
        this.receipts.delete(key);
        delete this.state.cursors[key];
        this.save();
        this.alive?.setIssues(this.sourceRefs());
    }

    async postExit(entry) {
        if (!this.hasMuteScope()) {
            this.log(`not posting an exit message in ${describeChannel(entry)}: it can't be muted without the notifications scope`, "warning");
            return;
        }
        try {
            await this.github.createComment(entry, encodeExit({ from: this.address }));
            await this.mute(entry.nodeId);
        } catch (error) {
            this.log(`could not post an exit message in ${describeChannel(entry)}: ${error.message}`, "warning");
        }
    }

    // The last `limit` messages in a channel (joined or not), for catching up on context.
    async history({ channel, limit = 20 }) {
        this.requireJoined();
        const count = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 100);
        const issue = await this.resolveChannel(channel);
        const key = issueKey(issue);
        const entries = [];
        const comments = (await this.github.listComments({ repo: issue.repo, number: issue.number })).sort((a, b) => a.id - b.id);
        for (const comment of comments) {
            const parsed = parseComment(comment);
            if (parsed.type === "heartbeat") continue;
            if (parsed.type === "message") this.rememberMessage(key, parsed.messageId, parsed.url);
            if (parsed.type !== "exit" && !parsed.body) continue;
            entries.push(parsed);
        }
        return formatHistory(entries.slice(-count), { channel: issue, total: entries.length, isTrusted: (m) => this.isTrusted(m.author) });
    }

    // replyTo: a message ID (m-…) or a comment permalink.
    async send({ channel, to, message, kind = "task", replyTo }) {
        this.requireJoined();
        if (!channel) throw new Error("Messages go through channels. Pass the channel issue's URL (join it first with peer_channel_join).");
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
        const source = this.sources.get(issueKey(parseChannel(channel)));
        if (!source) throw new Error("This session isn't in that channel. Join it with peer_channel_join first.");
        await this.requireMuteScope();
        const re = replyTo ? await this.resolveReply(source, replyTo) : null;
        const id = newMessageId();
        const text = encodeMessage({ id, from: this.address, to: addresses, re, kind, body });
        if (text.length > MAX_COMMENT_LENGTH) {
            throw new Error(
                `The message is too long: ${text.length.toLocaleString("en-US")} characters with headers, and GitHub comments are limited to ` +
                    `${MAX_COMMENT_LENGTH.toLocaleString("en-US")}. Shorten it, or put long content such as logs in a gist and link to it.`
            );
        }
        const comment = await this.github.createComment(source.ref, text);
        this.rememberMessage(source.key, id, comment.html_url);
        this.trackReceipt(source.key, { commentId: comment.id, messageId: id, repo: source.ref.repo, waiting: acknowledgers(addresses) });
        await this.mute(source.issue.node_id);
        const notes = await this.recipientNotes(source, addresses).catch(() => []);
        return { id, url: comment.html_url, notes };
    }

    // Online sessions in this session's channels (or in one given channel).
    async list({ channel } = {}) {
        this.requireJoined();
        const targets = channel ? [await this.resolveChannel(channel)] : this.state.channels;
        const result = [];
        for (const target of targets) {
            const sessions = (await this.statuses(target))
                .filter((s) => s.fresh)
                .map((s) => ({ address: `${s.author}/${s.session}`, self: s.commentId === this.entryFor(target)?.statusCommentId }))
                .sort((a, b) => a.address.localeCompare(b.address));
            result.push({ label: describeChannel(target), url: issueUrl(target), joined: Boolean(this.entryFor(target)), sessions });
        }
        return result;
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
            address: this.address,
            channels: this.state.channels.map(describeChannel),
            trusted: [...this.state.trusted],
            push: this.alive?.live ? "live" : "polling",
        };
    }

    // --- channels and heartbeat comments -------------------------------------------------------

    entryFor(ref) {
        const key = issueKey(ref);
        return this.state?.channels.find((c) => issueKey(c) === key) ?? null;
    }

    // Returns { repo, number, title, html_url, node_id, state }.
    async resolveChannel(channel) {
        const parsed = parseChannel(channel);
        const joined = this.sources.get(issueKey(parsed));
        if (joined) return joined.issue;
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
        return {
            repo: repoFromUrl(issue.html_url) ?? parsed.repo,
            number: issue.number,
            title: issue.title,
            html_url: issue.html_url,
            node_id: issue.node_id,
            state: issue.state,
        };
    }

    // Heartbeat comments in a channel, with whether each one's ❤️ heartbeat is fresh.
    async statuses(ref) {
        const result = [];
        for (const comment of await this.github.commentsWithHearts(ref)) {
            const parsed = parseComment(comment);
            if (parsed.type !== "heartbeat") continue;
            const beats = comment.hearts.filter((h) => sameLogin(h.login, parsed.author)).map((h) => Date.parse(h.createdAt));
            const heartAt = beats.length ? Math.max(...beats) : null;
            result.push({ ...parsed, heartAt, fresh: heartAt !== null && this.now() - heartAt < this.staleMs });
        }
        return result;
    }

    // Rejects a name another live session uses in this channel, and deletes this login's stale heartbeat comments for it.
    async checkNameFree(ref, login, name) {
        const mine = this.entryFor(ref)?.statusCommentId;
        for (const status of await this.statuses(ref)) {
            if (!sameLogin(status.author, login) || !sameSession(status.session, name) || status.commentId === mine) continue;
            if (status.fresh) {
                throw new Error(
                    `Another session is already listening in ${describeChannel(ref)} as ${login}/${status.session}. Pick a different name with peer_join.`
                );
            }
            await this.github.deleteComment(ref.repo, status.commentId).catch(() => {});
        }
    }

    async ensureStatus(entry) {
        if (entry.statusCommentId) {
            try {
                await this.github.getComment(entry.repo, entry.statusCommentId);
                await this.heartbeat(entry);
                return;
            } catch (error) {
                if (error.status !== 404) throw error;
                entry.statusCommentId = null;
                entry.heartReactionId = null;
            }
        }
        const comment = await this.github.createComment(entry, encodeHeartbeat({ from: this.address }));
        entry.statusCommentId = comment.id;
        entry.heartReactionId = null;
        this.save();
        await this.mute(entry.nodeId);
        await this.heartbeat(entry);
    }

    async deleteStatus(entry) {
        if (entry.statusCommentId) await this.github.deleteComment(entry.repo, entry.statusCommentId).catch(() => {});
        entry.statusCommentId = null;
        entry.heartReactionId = null;
    }

    // Removes and re-adds this session's ❤️ so the reaction's timestamp shows it's still listening.
    async heartbeat(entry) {
        if (!entry.statusCommentId) return;
        if (entry.heartReactionId) {
            await this.github.deleteReaction(entry.repo, entry.statusCommentId, entry.heartReactionId).catch(() => {});
            entry.heartReactionId = null;
        }
        try {
            entry.heartReactionId = (await this.github.addReaction(entry.repo, entry.statusCommentId, "heart")).id;
        } catch (error) {
            if (error.status !== 404) throw error;
            entry.statusCommentId = null;
            await this.ensureStatus(entry);
            return;
        }
        this.save();
    }

    async heartbeatAll() {
        for (const entry of this.state?.channels ?? []) {
            await this.heartbeat(entry).catch((e) => this.log(`heartbeat in ${describeChannel(entry)} failed: ${e.message}`, "warning"));
        }
    }

    // --- notifications ---------------------------------------------------------------------

    hasMuteScope() {
        return !this.github.scopes || this.github.scopes.has("notifications");
    }

    async requireMuteScope() {
        if (this.hasMuteScope()) return;
        // The person may have run `gh auth refresh -s notifications` since the token was read.
        await this.github.reauthenticate();
        if (!this.hasMuteScope()) throw new Error(MUTE_HELP);
    }

    // Stops GitHub notifying this user about the issue. With required, failure aborts the operation.
    async mute(nodeId, { required = false } = {}) {
        if (required) await this.requireMuteScope();
        if (!nodeId) return;
        try {
            await this.github.muteIssue(nodeId);
        } catch (error) {
            if (required) throw isScopeError(error) ? new Error(MUTE_HELP) : error;
            this.log(`could not mute a channel issue: ${error.message}`, "warning");
        }
    }

    async recipientNotes(source, addresses) {
        const online = (await this.statuses(source.ref)).filter((s) => s.fresh);
        const notes = [];
        for (const address of addresses) {
            if (address.kind === "all") {
                const others = online.filter((s) => !(sameLogin(s.author, this.me.login) && sameSession(s.session, this.me.session)));
                if (others.length === 0) notes.push("No other sessions are listening in this channel right now.");
            } else if (address.kind === "session" && !online.some((s) => sameLogin(s.author, address.login) && sameSession(s.session, address.session))) {
                notes.push(`${address.login}/${address.session} isn't listening in this channel right now. If it's joined but offline, it gets the message when it reconnects.`);
            } else if (address.kind === "person" && !online.some((s) => sameLogin(s.author, address.login))) {
                notes.push(`${address.login} has no sessions listening in this channel right now.`);
            }
        }
        return notes;
    }

    // --- replies ---------------------------------------------------------------------------

    rememberMessage(key, messageId, url) {
        if (!messageId) return;
        const index = this.messageIndex.get(key) ?? new Map();
        index.set(messageId, url);
        if (index.size > MAX_INDEXED_MESSAGES) index.delete(index.keys().next().value);
        this.messageIndex.set(key, index);
    }

    async resolveReply(source, value) {
        const text = String(value).trim();
        const permalink = COMMENT_URL.exec(text);
        if (permalink) {
            let comment;
            try {
                comment = await this.github.getComment(permalink[1], Number(permalink[3]));
            } catch {
                throw new Error(`Can't find the comment ${text} to reply to.`);
            }
            const parsed = parseComment(comment);
            if (parsed.type === "heartbeat" || parsed.type === "exit") throw new Error("That's not a message comment.");
            return { id: parsed.messageId, url: comment.html_url };
        }
        if (MESSAGE_ID.test(text)) {
            const known = this.messageIndex.get(source.key)?.get(text);
            if (known) return { id: text, url: known };
            for (const comment of await this.github.listComments(source.ref)) {
                const parsed = parseComment(comment);
                if (parsed.type === "message") this.rememberMessage(source.key, parsed.messageId, parsed.url);
                if (parsed.messageId === text) return { id: text, url: parsed.url };
            }
            throw new Error(`Can't find message ${text} in ${describeChannel(source.channel)}.`);
        }
        throw new Error(`reply_to must be a message ID (m-…) or a comment permalink, not "${value}".`);
    }

    // Checks that a message's `re` header points at a comment carrying that message ID.
    async verifyReply(message, key) {
        const { re } = message;
        if (!re) return;
        const known = re.id ? this.messageIndex.get(key)?.get(re.id) : null;
        if (known && COMMENT_URL.exec(known)?.[3] === String(re.commentId)) return;
        try {
            const target = parseComment(await this.github.getComment(re.repo, re.commentId));
            if ((target.type === "message" || target.type === "human") && target.messageId === re.id) return;
            message.reNote = "its re header doesn't match the linked comment, so it was ignored";
        } catch {
            message.reNote = "its re header couldn't be checked, so it was ignored";
        }
        message.re = null;
    }

    // --- connection ------------------------------------------------------------------------

    async connect() {
        this.clearTimers();
        this.stopped = false;
        const login = await this.github.login();
        this.me = { login, session: this.state.name };
        if (!this.hasMuteScope()) this.log(MUTE_HELP, "warning");
        this.sources.clear();
        for (const entry of [...this.state.channels]) {
            try {
                const issue = await this.resolveChannel(issueUrl(entry));
                Object.assign(entry, { title: issue.title, nodeId: issue.node_id });
                if (issue.state === "closed") {
                    await this.dropChannel(entry, { announce: false });
                    this.notify(`📪 ${describeChannel(entry)} was closed, so this session left it.`);
                    continue;
                }
                await this.addSource(issue, entry);
                await this.ensureStatus(entry);
            } catch (error) {
                this.log(`skipping channel ${describeChannel(entry)}: ${error.message}`, "warning");
            }
        }
        this.save();

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
        this.addTimer(setInterval(() => this.heartbeatAll(), this.heartbeatMs));
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
        if (!this.me) throw new Error("This session hasn't joined the peer bus. Call peer_join with a session name first.");
    }

    // --- receiving -------------------------------------------------------------------------

    sourceRefs() {
        return [...this.sources.values()].map((source) => source.ref);
    }

    async addSource(issue, channel) {
        const ref = { repo: issue.repo, number: issue.number };
        const key = issueKey(ref);
        this.sources.set(key, { key, ref, channel, issue });
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
        if (await this.leaveIfClosed(source)) return;
        await this.fetchNewComments(source);
        await this.checkReceipts(source);
    }

    async leaveIfClosed(source) {
        const issue = await this.github.getIssue(source.ref, { conditional: true });
        if (issue.state !== "closed" || !this.sources.has(source.key)) return false;
        await this.dropChannel(source.channel, { announce: false });
        this.notify(`📪 ${describeChannel(source.channel)} was closed, so this session left it.`);
        return true;
    }

    async fetchNewComments(source) {
        const { key } = source;
        const cursor = this.state.cursors[key] ?? { id: 0, createdAt: null };
        const comments = await this.github.listComments(source.ref, cursor.createdAt);
        const fresh = comments.filter((c) => c.id > cursor.id).sort((a, b) => a.id - b.id);
        if (fresh.length === 0 || !this.sources.has(key)) return;
        const last = fresh.at(-1);
        this.state.cursors[key] = { id: last.id, createdAt: last.created_at };
        this.save();

        const incoming = [];
        for (const comment of fresh) {
            const message = parseComment(comment);
            if (message.type === "heartbeat") continue;
            if (message.type === "exit") {
                const self = sameLogin(message.author, this.me.login) && sameSession(message.session, this.me.session);
                if (!self) this.notify(`👋 ${message.author}/${message.session} left ${describeChannel(source.channel)}.`);
                continue;
            }
            this.rememberMessage(key, message.messageId, message.url);
            if (!message.body || !isAddressedTo(message, this.me)) continue;
            incoming.push({ ...message, channel: source.channel });
        }
        for (const message of incoming) await this.verifyReply(message, key);
        const shown = this.dispatch(incoming);
        for (const message of shown) {
            if (!shouldAcknowledge(message, this.me)) continue;
            await this.github
                .addReaction(source.ref.repo, message.commentId, "eyes")
                .catch((e) => this.log(`could not mark ${message.messageId} as read: ${e.message}`, "warning"));
        }
    }

    // Remembers a sent message whose recipients will mark it read with 👀, so the sender can be told.
    trackReceipt(key, receipt) {
        if (receipt.waiting.size === 0) return;
        const pending = this.receipts.get(key) ?? new Map();
        pending.set(receipt.commentId, { ...receipt, sentAt: this.now() });
        if (pending.size > MAX_PENDING_RECEIPTS) pending.delete(pending.keys().next().value);
        this.receipts.set(key, pending);
    }

    async checkReceipts(source) {
        const pending = this.receipts.get(source.key);
        if (!pending) return;
        for (const [commentId, receipt] of pending) {
            if (this.now() - receipt.sentAt > RECEIPT_TTL_MS) {
                pending.delete(commentId);
                continue;
            }
            let reactions;
            try {
                reactions = await this.github.listReactions(receipt.repo, commentId, "eyes");
            } catch (error) {
                if (error.status === 404) pending.delete(commentId);
                continue;
            }
            for (const reaction of reactions) {
                const login = reaction.user?.login?.toLowerCase();
                const address = login && receipt.waiting.get(login);
                if (!address) continue;
                receipt.waiting.delete(login);
                this.notify(`👀 ${address} read ${receipt.messageId} in ${describeChannel(source.channel)}.`);
            }
            if (receipt.waiting.size === 0) pending.delete(commentId);
        }
    }

    isTrusted(login) {
        return sameLogin(login, this.me.login) || this.state.trusted.some((l) => sameLogin(l, login));
    }

    // Delivers trusted tasks to the agent and everything else to the human. Returns the messages shown.
    dispatch(incoming) {
        const tasks = [];
        const notes = [];
        for (const message of incoming) {
            const trusted = this.isTrusted(message.author);
            if (message.kind === "task" && trusted) tasks.push(message);
            else notes.push({ message, untrustedTask: message.kind === "task" });
        }
        const shownNotes = notes.slice(-MAX_CATCH_UP);
        if (notes.length > shownNotes.length) this.notify(`📨 ${notes.length - shownNotes.length} older peer notification(s) skipped.`);
        for (const { message, untrustedTask } of shownNotes) {
            const suffix = untrustedTask
                ? ` (not given to the agent: ${message.author} isn't trusted in this session; use peer_trust to allow)`
                : "";
            const id = message.messageId ? ` ${message.messageId}` : "";
            this.notify(`📨${id} from ${senderAddress(message)} in ${describeChannel(message.channel)}: ${truncate(message.body, 400)} ${message.url}${suffix}`);
        }
        const shownTasks = tasks.slice(-MAX_CATCH_UP);
        if (shownTasks.length > 0) this.deliver(formatPrompt(shownTasks, this.me, { omitted: tasks.length - shownTasks.length }));
        return [...shownNotes.map((n) => n.message), ...shownTasks];
    }
}
