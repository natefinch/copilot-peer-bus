// In-memory fake of the GitHub REST/GraphQL endpoints the peer bus uses, plus a fake Alive watcher.

import { createHash } from "node:crypto";
import http from "node:http";

import { issueKey } from "../../.github/extensions/peer-bus/protocol.mjs";

const iso = (ms = Date.now()) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

// repos: { "acme/app": { members: ["natefinch"] } } (members omitted = everyone has access).
// scopes: the X-OAuth-Scopes header value; null omits the header (like a fine-grained token).
export function createFakeGitHub({ repos = { "acme/channels": {} }, users = ["natefinch", "alice", "bob"], scopes = "repo, notifications" } = {}) {
    const issues = [];
    const comments = [];
    const reactions = [];
    const mutes = [];
    const failures = [];
    const listeners = new Set();
    const stats = { requests: 0, notModified: 0 };
    let nextComment = 1000;
    let nextReaction = 1;
    let baseUrl = "";
    const hasNotifications = scopes === null || scopes.split(",").map((s) => s.trim()).includes("notifications");

    const repoInfo = (fullName) => {
        const match = Object.keys(repos).find((r) => r.toLowerCase() === String(fullName).toLowerCase());
        return match ? { name: match, ...repos[match] } : null;
    };
    const canAccess = (login, fullName) => {
        const info = repoInfo(fullName);
        return Boolean(info && (!info.members || info.members.includes(login)));
    };
    const emit = (repo, number) => {
        for (const listener of listeners) listener(issueKey({ repo, number }));
    };
    const issueJson = (issue) => ({
        number: issue.number,
        ...(issue.pull ? { pull_request: {} } : {}),
        title: issue.title,
        body: issue.body,
        state: issue.state,
        user: { login: issue.author },
        node_id: `I_${issue.repo}_${issue.number}`,
        html_url: `https://github.com/${issue.repo}/issues/${issue.number}`,
        comments: comments.filter((c) => c.repo === issue.repo && c.issue === issue.number).length,
    });
    const commentUrl = (c) => `https://github.com/${c.repo}/issues/${c.issue}#issuecomment-${c.id}`;
    const commentJson = (c) => ({
        id: c.id,
        node_id: `IC_${c.id}`,
        body: c.body,
        user: { login: c.author },
        created_at: c.created_at,
        updated_at: c.updated_at,
        html_url: commentUrl(c),
    });

    function addIssue(author, title, body = "", repo = Object.keys(repos)[0], { pull = false } = {}) {
        const fullName = repoInfo(repo).name;
        const number = issues.filter((i) => i.repo === fullName).length + 1;
        const issue = { repo: fullName, number, title, body, author, state: "open", pull };
        issues.push(issue);
        return issueJson(issue);
    }

    function addComment(author, number, body, repo = Object.keys(repos)[0]) {
        const now = iso();
        const comment = { id: nextComment++, repo: repoInfo(repo).name, issue: number, author, body, created_at: now, updated_at: now };
        comments.push(comment);
        setImmediate(() => emit(comment.repo, number));
        return commentJson(comment);
    }

    function send(res, status, value, headers = {}) {
        res.writeHead(status, { "Content-Type": "application/json", ...(scopes === null ? {} : { "X-OAuth-Scopes": scopes }), ...headers });
        res.end(value === undefined ? "" : JSON.stringify(value));
    }

    function sendList(req, res, url, items) {
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        const slice = items.slice((page - 1) * perPage, page * perPage);
        const headers = {};
        if (page * perPage < items.length) {
            const next = new URL(url.href);
            next.searchParams.set("page", String(page + 1));
            headers.Link = `<${baseUrl}${next.pathname}${next.search}>; rel="next"`;
        }
        const body = JSON.stringify(slice);
        const etag = `"${createHash("sha1").update(body + (headers.Link ?? "")).digest("hex")}"`;
        if (req.headers["if-none-match"] === etag) {
            stats.notModified++;
            res.writeHead(304, { ETag: etag });
            return res.end();
        }
        return send(res, 200, slice, { ETag: etag, ...headers });
    }

    async function readJson(req) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    }

    async function graphql(req, res, login) {
        const { query, variables } = await readJson(req);
        if (query.includes("updateSubscription")) {
            if (!hasNotifications) {
                return send(res, 200, { errors: [{ type: "INSUFFICIENT_SCOPES", message: "requires one of the following scopes: ['notifications']" }] });
            }
            mutes.push({ login, id: variables.id, state: variables.state });
            return send(res, 200, { data: { updateSubscription: { clientMutationId: null } } });
        }
        if (query.includes("reactions(content: HEART")) {
            const fullName = `${variables.owner}/${variables.name}`;
            if (!canAccess(login, fullName)) return send(res, 200, { data: { repository: null }, errors: [{ message: "Could not resolve" }] });
            const repo = repoInfo(fullName).name;
            const nodes = comments
                .filter((c) => c.repo === repo && c.issue === variables.number)
                .sort((a, b) => a.id - b.id)
                .map((c) => ({
                    databaseId: c.id,
                    body: c.body,
                    url: commentUrl(c),
                    createdAt: c.created_at,
                    author: { login: c.author },
                    reactions: { nodes: reactions.filter((r) => r.commentId === c.id && r.content === "heart").map((r) => ({ createdAt: r.created_at, user: { login: r.user } })) },
                }));
            return send(res, 200, { data: { repository: { issue: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
        }
        if (query.includes("updatesChannel")) {
            const data = {};
            const errors = [];
            const segments = query.split(/\b(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/);
            for (let k = 1; k < segments.length; k += 4) {
                const [alias, fullName, body] = [segments[k], `${segments[k + 1]}/${segments[k + 2]}`, segments[k + 3]];
                if (!canAccess(login, fullName)) {
                    data[alias] = null;
                    errors.push({ message: `Could not resolve to a Repository with the name '${fullName}'.` });
                    continue;
                }
                data[alias] = {};
                for (const [, issueAlias, number] of body.matchAll(/(i\d+): issue\(number: (\d+)\)/g)) {
                    const payload = Buffer.from(JSON.stringify({ c: `issue:${issueKey({ repo: fullName, number })}`, t: 1 })).toString("base64");
                    data[alias][issueAlias] = { updatesChannel: `${payload}--sig` };
                }
            }
            return send(res, 200, errors.length ? { data, errors } : { data });
        }
        return send(res, 200, { errors: [{ message: "unsupported query" }] });
    }

    const server = http.createServer(async (req, res) => {
        stats.requests++;
        const url = new URL(req.url, baseUrl);
        const failure = failures.find((f) => f.count > 0 && (!f.method || f.method === req.method));
        if (failure) {
            failure.count--;
            return send(res, failure.status, { message: failure.message }, failure.headers);
        }
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const login = users.find((u) => token === `tok-${u}`);
        if (!login) return send(res, 401, { message: "Bad credentials" });
        const path = url.pathname;
        let match;

        if (req.method === "GET" && path === "/user") return send(res, 200, { login });
        if (req.method === "GET" && path === "/alive_internal/websocket-url") return send(res, 200, { url: "ws://fake-alive" });
        if (req.method === "POST" && path === "/graphql") return graphql(req, res, login);

        const repoMatch = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(path);
        if (!repoMatch || !canAccess(login, repoMatch[1])) return send(res, 404, { message: "Not Found" });
        const repo = repoInfo(repoMatch[1]).name;
        const rest = repoMatch[2];
        const findIssue = (number) => issues.find((i) => i.repo === repo && i.number === Number(number));
        const findComment = (id) => comments.find((c) => c.repo === repo && c.id === Number(id));

        if (req.method === "POST" && rest === "/issues") {
            const { title, body } = await readJson(req);
            return send(res, 201, addIssue(login, title, body, repo));
        }
        if ((match = /^\/issues\/(\d+)$/.exec(rest))) {
            const issue = findIssue(match[1]);
            if (!issue) return send(res, 404, { message: "Not Found" });
            if (req.method === "GET") return send(res, 200, issueJson(issue));
            if (req.method === "PATCH") {
                const { state } = await readJson(req);
                if (state) issue.state = state;
                setImmediate(() => emit(issue.repo, issue.number));
                return send(res, 200, issueJson(issue));
            }
        }
        if ((match = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
            const number = Number(match[1]);
            if (!findIssue(number)) return send(res, 404, { message: "Not Found" });
            if (req.method === "GET") {
                const since = url.searchParams.get("since");
                const list = comments
                    .filter((c) => c.repo === repo && c.issue === number && (!since || Date.parse(c.updated_at) >= Date.parse(since)))
                    .sort((a, b) => a.id - b.id);
                return sendList(req, res, url, list.map(commentJson));
            }
            if (req.method === "POST") {
                const { body } = await readJson(req);
                return send(res, 201, addComment(login, number, body, repo));
            }
        }
        if ((match = /^\/issues\/comments\/(\d+)$/.exec(rest))) {
            const comment = findComment(match[1]);
            if (!comment) return send(res, 404, { message: "Not Found" });
            if (req.method === "GET") return send(res, 200, commentJson(comment));
            if (comment.author !== login) return send(res, 403, { message: "Forbidden" });
            if (req.method === "DELETE") {
                comments.splice(comments.indexOf(comment), 1);
                for (let i = reactions.length - 1; i >= 0; i--) if (reactions[i].commentId === comment.id) reactions.splice(i, 1);
                setImmediate(() => emit(comment.repo, comment.issue));
                return send(res, 204);
            }
        }
        if ((match = /^\/issues\/comments\/(\d+)\/reactions$/.exec(rest)) && req.method === "GET") {
            const content = url.searchParams.get("content");
            const list = reactions.filter((r) => r.commentId === Number(match[1]) && (!content || r.content === content));
            return sendList(req, res, url, list.map((r) => ({ id: r.id, content: r.content, user: { login: r.user }, created_at: r.created_at })));
        }
        if ((match = /^\/issues\/comments\/(\d+)\/reactions$/.exec(rest)) && req.method === "POST") {
            const comment = findComment(match[1]);
            if (!comment) return send(res, 404, { message: "Not Found" });
            const { content } = await readJson(req);
            const existing = reactions.find((r) => r.commentId === comment.id && r.user === login && r.content === content);
            if (existing) return send(res, 200, { id: existing.id, content, user: { login } });
            const reaction = { id: nextReaction++, commentId: comment.id, user: login, content, created_at: new Date().toISOString() };
            reactions.push(reaction);
            setImmediate(() => emit(comment.repo, comment.issue));
            return send(res, 201, { id: reaction.id, content, user: { login } });
        }
        if ((match = /^\/issues\/comments\/(\d+)\/reactions\/(\d+)$/.exec(rest)) && req.method === "DELETE") {
            const comment = findComment(match[1]);
            const index = reactions.findIndex((r) => r.commentId === Number(match[1]) && r.id === Number(match[2]) && r.user === login);
            if (!comment || index === -1) return send(res, 404, { message: "Not Found" });
            reactions.splice(index, 1);
            setImmediate(() => emit(comment.repo, comment.issue));
            return send(res, 204);
        }
        return send(res, 404, { message: "Not Found" });
    });

    return {
        issues,
        comments,
        reactions,
        mutes,
        stats,
        addIssue,
        addComment,
        // Makes the next `count` requests (optionally only of `method`) fail with the given response.
        failNext(count, { status, message = "", headers = {}, method } = {}) {
            failures.push({ count, status, message, headers, method });
        },
        closeIssue(number, repo = Object.keys(repos)[0]) {
            const issue = issues.find((i) => i.repo === repoInfo(repo).name && i.number === number);
            issue.state = "closed";
            setImmediate(() => emit(issue.repo, issue.number));
        },
        get url() {
            return baseUrl;
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async listen() {
            await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            return baseUrl;
        },
        close() {
            server.closeAllConnections?.();
            return new Promise((resolve) => server.close(resolve));
        },
    };
}

// Stands in for AliveWatcher: signals the bus whenever the fake server changes a watched issue.
export class FakeAlive {
    constructor(fake, { onSignal, onLiveChange = () => {} }) {
        Object.assign(this, { fake, onSignal, onLiveChange });
        this.issues = new Set();
        this.live = false;
        this.off = null;
    }

    setIssues(refs) {
        this.issues = new Set(refs.map(issueKey));
    }

    start() {
        this.off ??= this.fake.onChange((key) => {
            if (this.live && this.issues.has(key)) this.onSignal(key);
        });
        if (!this.live) {
            this.live = true;
            this.onLiveChange(true);
        }
    }

    stop() {
        this.off?.();
        this.off = null;
        this.live = false;
    }
}
