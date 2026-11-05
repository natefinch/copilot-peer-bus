// In-memory fake of the GitHub REST/GraphQL endpoints the peer bus uses, plus a fake Alive watcher.

import { createHash } from "node:crypto";
import http from "node:http";

import { issueKey } from "../../.github/extensions/peer-bus/protocol.mjs";

const iso = (ms = Date.now()) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

// repos: extra repositories beyond the bus repo, e.g. { "acme/app": { members: ["natefinch"] } } (members omitted = everyone).
export function createFakeGitHub({ repo = "acme/bus", repos = {}, users = ["natefinch", "alice", "bob"], isPrivate = true, scopes = null } = {}) {
    const allRepos = { [repo]: { private: isPrivate }, ...repos };
    const repoInfo = (fullName) => {
        const match = Object.keys(allRepos).find((r) => r.toLowerCase() === String(fullName).toLowerCase());
        return match ? { name: match, ...allRepos[match] } : null;
    };
    const canAccess = (login, fullName) => {
        const info = repoInfo(fullName);
        return Boolean(info && (!info.members || info.members.includes(login)));
    };
    const issues = [];
    const comments = [];
    const unsubscribed = [];
    const unwatched = [];
    const listeners = new Set();
    const stats = { requests: 0, notModified: 0 };
    let nextComment = 1000;
    let baseUrl = "";

    const keyOf = (r, number) => `${r.toLowerCase()}#${number}`;
    const emit = (r, number) => {
        for (const listener of listeners) listener(keyOf(r, number));
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
    const commentJson = (c) => ({
        id: c.id,
        node_id: `IC_${c.id}`,
        body: c.body,
        user: { login: c.author },
        created_at: c.created_at,
        updated_at: c.updated_at,
        html_url: `https://github.com/${c.repo}/issues/${c.issue}#issuecomment-${c.id}`,
    });

    function addIssue(author, title, body = "", inRepo = repo, { pull = false } = {}) {
        const fullName = repoInfo(inRepo).name;
        const number = issues.filter((i) => i.repo === fullName).length + 1;
        const issue = { repo: fullName, number, title, body, author, state: "open", pull };
        issues.push(issue);
        return issueJson(issue);
    }

    function addComment(author, number, body, inRepo = repo) {
        const now = iso();
        const comment = { id: nextComment++, repo: repoInfo(inRepo).name, issue: number, author, body, created_at: now, updated_at: now };
        comments.push(comment);
        setImmediate(() => emit(comment.repo, number));
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
                const listed = `${variables.owner}/${variables.name}`;
                if (!canAccess(login, listed)) return send(res, 200, { data: { repository: null }, errors: [{ message: "Could not resolve" }] });
                const nodes = issues
                    .filter((i) => i.state === "open" && i.repo.toLowerCase() === listed.toLowerCase())
                    .sort((a, b) => a.number - b.number)
                    .map((i) => {
                        const json = issueJson(i);
                        return { number: json.number, title: json.title, id: json.node_id, url: json.html_url, author: { login: i.author } };
                    });
                return send(res, 200, { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
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
                        const payload = Buffer.from(JSON.stringify({ c: `issue:${keyOf(fullName, number)}`, t: 1 })).toString("base64");
                        data[alias][issueAlias] = { updatesChannel: `${payload}--sig` };
                    }
                }
                return send(res, 200, errors.length ? { data, errors } : { data });
            }
            return send(res, 200, { errors: [{ message: "unsupported query" }] });
        }
        const repoMatch = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(path);
        if (!repoMatch || !canAccess(login, repoMatch[1])) return send(res, 404, { message: "Not Found" });
        const current = repoInfo(repoMatch[1]);
        const rest = repoMatch[2];
        const inRepo = (i) => i.repo === current.name;

        if (req.method === "GET" && rest === "") return send(res, 200, { full_name: current.name, private: current.private !== false });
        if (req.method === "DELETE" && rest === "/subscription") {
            unwatched.push(login);
            return send(res, 204);
        }
        if (req.method === "GET" && rest === "/issues") {
            const open = issues.filter((i) => inRepo(i) && i.state === "open").sort((a, b) => b.number - a.number);
            return sendList(req, res, url, open.map(issueJson));
        }
        if (req.method === "POST" && rest === "/issues") {
            const { title, body } = await readJson(req);
            return send(res, 201, addIssue(login, title, body, current.name));
        }
        if ((match = /^\/issues\/(\d+)$/.exec(rest))) {
            const issue = issues.find((i) => inRepo(i) && i.number === Number(match[1]));
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
            if (!issues.some((i) => inRepo(i) && i.number === number)) return send(res, 404, { message: "Not Found" });
            if (req.method === "GET") {
                const since = url.searchParams.get("since");
                const list = comments
                    .filter((c) => c.repo === current.name && c.issue === number && (!since || Date.parse(c.updated_at) >= Date.parse(since)))
                    .sort((a, b) => a.id - b.id);
                return sendList(req, res, url, list.map(commentJson));
            }
            if (req.method === "POST") {
                const { body } = await readJson(req);
                return send(res, 201, addComment(login, number, body, current.name));
            }
        }
        if ((match = /^\/issues\/comments\/(\d+)$/.exec(rest))) {
            const comment = comments.find((c) => c.repo === current.name && c.id === Number(match[1]));
            if (!comment) return send(res, 404, { message: "Not Found" });
            if (comment.author !== login) return send(res, 403, { message: "Forbidden" });
            if (req.method === "PATCH") {
                comment.body = (await readJson(req)).body;
                comment.updated_at = iso();
                setImmediate(() => emit(comment.repo, comment.issue));
                return send(res, 200, commentJson(comment));
            }
            if (req.method === "DELETE") {
                comments.splice(comments.indexOf(comment), 1);
                setImmediate(() => emit(comment.repo, comment.issue));
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
