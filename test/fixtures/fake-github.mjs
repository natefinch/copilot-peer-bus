// In-memory fake of the GitHub REST/GraphQL endpoints the peer bus uses, plus a fake Alive watcher.

import { createHash } from "node:crypto";
import http from "node:http";

const iso = (ms = Date.now()) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

export function createFakeGitHub({ repo = "acme/bus", users = ["natefinch", "alice", "bob"], isPrivate = true, scopes = null } = {}) {
    const [owner, name] = repo.split("/");
    const issues = [];
    const comments = [];
    const unsubscribed = [];
    const unwatched = [];
    const listeners = new Set();
    const stats = { requests: 0, notModified: 0 };
    let nextIssue = 1;
    let nextComment = 1000;
    let baseUrl = "";

    const emit = (number) => {
        for (const listener of listeners) listener(number);
    };
    const issueJson = (issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        user: { login: issue.author },
        node_id: `I_${issue.number}`,
        html_url: `https://github.com/${repo}/issues/${issue.number}`,
        comments: comments.filter((c) => c.issue === issue.number).length,
    });
    const commentJson = (c) => ({
        id: c.id,
        node_id: `IC_${c.id}`,
        body: c.body,
        user: { login: c.author },
        created_at: c.created_at,
        updated_at: c.updated_at,
        html_url: `https://github.com/${repo}/issues/${c.issue}#issuecomment-${c.id}`,
    });

    function addIssue(author, title, body = "") {
        const issue = { number: nextIssue++, title, body, author, state: "open" };
        issues.push(issue);
        return issueJson(issue);
    }

    function addComment(author, number, body) {
        const now = iso();
        const comment = { id: nextComment++, issue: number, author, body, created_at: now, updated_at: now };
        comments.push(comment);
        setImmediate(() => emit(number));
        return commentJson(comment);
    }

    function send(res, status, value, headers = {}) {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
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
        res.writeHead(200, { "Content-Type": "application/json", ETag: etag, ...headers });
        res.end(body);
    }

    async function readJson(req) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    }

    const server = http.createServer(async (req, res) => {
        stats.requests++;
        const url = new URL(req.url, baseUrl);
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const login = users.find((u) => token === `tok-${u}`);
        if (!login) return send(res, 401, { message: "Bad credentials" });
        const path = url.pathname;
        const repoBase = `/repos/${owner}/${name}`;
        let match;

        if (req.method === "GET" && path === "/user") return send(res, 200, { login }, scopes === null ? {} : { "X-OAuth-Scopes": scopes });
        if (req.method === "GET" && path === "/alive_internal/websocket-url") return send(res, 200, { url: "ws://fake-alive" });
        if (req.method === "POST" && path === "/graphql") {
            const { query, variables } = await readJson(req);
            if (query.includes("updateSubscription")) {
                unsubscribed.push({ login, id: variables.id });
                return send(res, 200, { data: { updateSubscription: { clientMutationId: null } } });
            }
            if (query.includes("issues(first: 100")) {
                const nodes = issues
                    .filter((i) => i.state === "open")
                    .sort((a, b) => a.number - b.number)
                    .map((i) => {
                        const json = issueJson(i);
                        return { number: json.number, title: json.title, id: json.node_id, url: json.html_url, author: { login: i.author } };
                    });
                return send(res, 200, { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
            }
            if (query.includes("updatesChannel")) {
                const repository = {};
                for (const [, alias, number] of query.matchAll(/(i\d+): issue\(number: (\d+)\)/g)) {
                    const payload = Buffer.from(JSON.stringify({ c: `issue:${number}`, t: 1 })).toString("base64");
                    repository[alias] = { updatesChannel: `${payload}--sig` };
                }
                return send(res, 200, { data: { repository } });
            }
            return send(res, 200, { errors: [{ message: "unsupported query" }] });
        }
        if (!path.startsWith(repoBase)) return send(res, 404, { message: "Not Found" });
        const rest = path.slice(repoBase.length);

        if (req.method === "GET" && rest === "") return send(res, 200, { full_name: repo, private: isPrivate });
        if (req.method === "DELETE" && rest === "/subscription") {
            unwatched.push(login);
            return send(res, 204);
        }
        if (req.method === "GET" && rest === "/issues") {
            const open = issues.filter((i) => i.state === "open").sort((a, b) => b.number - a.number);
            return sendList(req, res, url, open.map(issueJson));
        }
        if (req.method === "POST" && rest === "/issues") {
            const { title, body } = await readJson(req);
            return send(res, 201, addIssue(login, title, body));
        }
        if ((match = /^\/issues\/(\d+)$/.exec(rest))) {
            const issue = issues.find((i) => i.number === Number(match[1]));
            if (!issue) return send(res, 404, { message: "Not Found" });
            if (req.method === "GET") return send(res, 200, issueJson(issue));
            if (req.method === "PATCH") {
                const { state } = await readJson(req);
                if (state) issue.state = state;
                return send(res, 200, issueJson(issue));
            }
        }
        if ((match = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
            const number = Number(match[1]);
            if (!issues.some((i) => i.number === number)) return send(res, 404, { message: "Not Found" });
            if (req.method === "GET") {
                const since = url.searchParams.get("since");
                const list = comments
                    .filter((c) => c.issue === number && (!since || Date.parse(c.updated_at) >= Date.parse(since)))
                    .sort((a, b) => a.id - b.id);
                return sendList(req, res, url, list.map(commentJson));
            }
            if (req.method === "POST") {
                const { body } = await readJson(req);
                return send(res, 201, addComment(login, number, body));
            }
        }
        if ((match = /^\/issues\/comments\/(\d+)$/.exec(rest))) {
            const comment = comments.find((c) => c.id === Number(match[1]));
            if (!comment) return send(res, 404, { message: "Not Found" });
            if (comment.author !== login) return send(res, 403, { message: "Forbidden" });
            if (req.method === "PATCH") {
                comment.body = (await readJson(req)).body;
                comment.updated_at = iso();
                setImmediate(() => emit(comment.issue));
                return send(res, 200, commentJson(comment));
            }
            if (req.method === "DELETE") {
                comments.splice(comments.indexOf(comment), 1);
                setImmediate(() => emit(comment.issue));
                return send(res, 204);
            }
        }
        return send(res, 404, { message: "Not Found" });
    });

    return {
        repo,
        issues,
        comments,
        unsubscribed,
        unwatched,
        stats,
        addIssue,
        addComment,
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

    setIssues(numbers) {
        this.issues = new Set(numbers.map(Number));
    }

    start() {
        this.off ??= this.fake.onChange((number) => {
            if (this.live && this.issues.has(number)) this.onSignal(number);
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
