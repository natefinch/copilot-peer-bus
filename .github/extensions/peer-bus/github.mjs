// Minimal GitHub REST/GraphQL client for the peer bus. Dependency-free.

import { execFile } from "node:child_process";

import { issueKey } from "./protocol.mjs";

export class GitHubError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export function ghCliToken() {
    return new Promise((resolve, reject) => {
        execFile("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 10_000 }, (error, stdout) => {
            const token = stdout?.trim();
            if (error || !token) {
                reject(new Error("Could not get a GitHub token from the GitHub CLI. Install gh and run `gh auth login`."));
            } else {
                resolve(token);
            }
        });
    });
}

export function defaultTokenProvider(env = process.env) {
    return env.PEER_BUS_GITHUB_TOKEN ? async () => env.PEER_BUS_GITHUB_TOKEN : ghCliToken;
}

function nextLink(header) {
    return /<([^>]+)>;\s*rel="next"/.exec(header ?? "")?.[1] ?? null;
}

export class GitHub {
    constructor({ tokenProvider = defaultTokenProvider(), apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch } = {}) {
        Object.assign(this, { tokenProvider, apiUrl: apiUrl.replace(/\/+$/, ""), fetchImpl });
        this.token = null;
        this.etags = new Map();
        this.viewer = null;
        this.scopes = null; // Set of OAuth scopes when GitHub reports them (classic and OAuth tokens only)
    }

    async authHeader(refresh = false) {
        if (!this.token || refresh) this.token = await this.tokenProvider();
        return `Bearer ${this.token}`;
    }

    // Returns { status, data, link }. Throws GitHubError for non-2xx/304 responses.
    async raw(method, pathOrUrl, { body, conditional = false } = {}) {
        const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`;
        let response;
        for (const refresh of [false, true]) {
            const headers = {
                Authorization: await this.authHeader(refresh),
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "copilot-peer-bus",
            };
            if (body !== undefined) headers["Content-Type"] = "application/json";
            const cached = conditional ? this.etags.get(url) : undefined;
            if (cached) headers["If-None-Match"] = cached.etag;
            response = await this.fetchImpl(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
            if (response.status === 304 && cached) return { status: 304, data: cached.data, link: cached.link };
            if (response.status !== 401) break;
        }
        const scopes = response.headers.get("x-oauth-scopes");
        if (scopes !== null) this.scopes = new Set(scopes.split(",").map((scope) => scope.trim()).filter(Boolean));
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        if (!response.ok) {
            let message = data?.message ?? `HTTP ${response.status}`;
            if (response.status === 403 || response.status === 429) {
                const retry = response.headers.get("retry-after");
                if (retry) message += ` (retry after ${retry}s)`;
            }
            throw new GitHubError(`GitHub ${method} ${url.replace(this.apiUrl, "")} failed: ${message}`, response.status);
        }
        const etag = response.headers.get("etag");
        const link = response.headers.get("link");
        if (conditional && etag) {
            this.etags.delete(url);
            this.etags.set(url, { etag, data, link });
            if (this.etags.size > 200) this.etags.delete(this.etags.keys().next().value);
        }
        return { status: response.status, data, link };
    }

    async request(method, path, body) {
        return (await this.raw(method, path, { body })).data;
    }

    async paginate(path, { conditional = false } = {}) {
        const items = [];
        let url = path;
        while (url) {
            const { data, link } = await this.raw("GET", url, { conditional });
            items.push(...data);
            url = nextLink(link);
        }
        return items;
    }

    // With partial: true, returns whatever data GitHub resolved even if some fields errored.
    async graphql(query, variables = {}, { partial = false } = {}) {
        const result = await this.request("POST", "/graphql", { query, variables });
        if (result?.errors?.length && !(partial && result.data)) {
            const scopeError = result.errors.some((e) => e.type === "INSUFFICIENT_SCOPES");
            throw new GitHubError(`GitHub GraphQL failed: ${result.errors.map((e) => e.message).join("; ")}`, scopeError ? 403 : 200);
        }
        return result.data;
    }

    async login() {
        this.viewer ??= (await this.request("GET", "/user")).login;
        return this.viewer;
    }

    // Issue operations take a ref: { repo: "owner/name", number }.
    issuePath({ repo, number }, suffix = "") {
        return `/repos/${repo}/issues/${number}${suffix}`;
    }

    createIssue(title, body, repo) {
        return this.request("POST", `/repos/${repo}/issues`, { title, body });
    }

    getIssue(ref) {
        return this.request("GET", this.issuePath(ref));
    }

    async closeIssue(ref) {
        await this.request("PATCH", this.issuePath(ref), { state: "closed", state_reason: "not_planned" });
    }

    // REST `since` filters by updated time, so callers also filter by comment ID.
    listComments(ref, since) {
        const query = new URLSearchParams({ per_page: "100" });
        if (since) query.set("since", since);
        return this.paginate(this.issuePath(ref, `/comments?${query}`), { conditional: true });
    }

    async latestComment(ref) {
        const issue = await this.getIssue(ref);
        if (!issue.comments) return null;
        const page = await this.request("GET", this.issuePath(ref, `/comments?per_page=1&page=${issue.comments}`));
        return page[0] ?? null;
    }

    createComment(ref, body) {
        return this.request("POST", this.issuePath(ref, "/comments"), { body });
    }

    getComment(repo, id) {
        return this.request("GET", `/repos/${repo}/issues/comments/${id}`);
    }

    async deleteComment(repo, id) {
        await this.request("DELETE", `/repos/${repo}/issues/comments/${id}`);
    }

    // Returns the reaction; GitHub returns the existing one if this user already reacted with `content`.
    addReaction(repo, commentId, content) {
        return this.request("POST", `/repos/${repo}/issues/comments/${commentId}/reactions`, { content });
    }

    async deleteReaction(repo, commentId, reactionId) {
        await this.request("DELETE", `/repos/${repo}/issues/comments/${commentId}/reactions/${reactionId}`);
    }

    // Every comment on an issue with its ❤️ reactions, for finding status-heartbeat comments.
    async commentsWithHearts({ repo, number }) {
        const [owner, name] = repo.split("/");
        const comments = [];
        let after = null;
        do {
            const data = await this.graphql(
                `query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) {
                    issue(number: $number) { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
                        nodes { databaseId body url createdAt author { login }
                            reactions(content: HEART, first: 50) { nodes { createdAt user { login } } } } } } } }`,
                { owner, name, number: Number(number), after }
            );
            const connection = data?.repository?.issue?.comments;
            if (!connection) break;
            for (const node of connection.nodes) {
                comments.push({
                    id: node.databaseId,
                    body: node.body,
                    html_url: node.url,
                    created_at: node.createdAt,
                    user: { login: node.author?.login },
                    hearts: node.reactions.nodes.map((r) => ({ login: r.user?.login, createdAt: r.createdAt })),
                });
            }
            after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
        } while (after);
        return comments;
    }

    // Stops GitHub notifying this user about an issue. Needs the `notifications` scope.
    async muteIssue(nodeId) {
        const mutate = (state) =>
            this.graphql("mutation($id: ID!, $state: SubscriptionState!) { updateSubscription(input: { subscribableId: $id, state: $state }) { clientMutationId } }", {
                id: nodeId,
                state,
            });
        try {
            await mutate("IGNORED");
        } catch (error) {
            if (error.status === 403) throw error;
            await mutate("UNSUBSCRIBED");
        }
    }

    async aliveSocketUrl() {
        return (await this.request("GET", "/alive_internal/websocket-url")).url;
    }

    // Returns Map(issueKey -> signed Alive channel) for the issues' UPDATED channel. Issues that can't be
    // resolved (no access, deleted) are left out rather than failing the whole lookup.
    async issueUpdateChannels(refs) {
        const result = new Map();
        const byRepo = new Map();
        for (const ref of refs) {
            const repoKey = ref.repo.toLowerCase();
            if (!byRepo.has(repoKey)) byRepo.set(repoKey, { repo: ref.repo, numbers: new Set() });
            byRepo.get(repoKey).numbers.add(Number(ref.number));
        }
        if (byRepo.size === 0) return result;
        const groups = [...byRepo.values()];
        const parts = groups.map(({ repo, numbers }, index) => {
            const [owner, name] = repo.split("/");
            const fields = [...numbers].map((n) => `i${n}: issue(number: ${n}) { updatesChannel(name: UPDATED) }`).join(" ");
            return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }`;
        });
        const data = await this.graphql(`query { ${parts.join("\n")} }`, {}, { partial: true });
        groups.forEach(({ repo, numbers }, index) => {
            for (const n of numbers) {
                const channel = data?.[`r${index}`]?.[`i${n}`]?.updatesChannel;
                if (channel) result.set(issueKey({ repo, number: n }), channel);
            }
        });
        return result;
    }
}
