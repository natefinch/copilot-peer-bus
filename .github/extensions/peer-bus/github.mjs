// Minimal GitHub REST/GraphQL client for the peer bus. Dependency-free.

import { execFile } from "node:child_process";

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
    constructor({ repo, tokenProvider = defaultTokenProvider(), apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch }) {
        const [owner, name, extra] = String(repo ?? "").split("/");
        if (!owner || !name || extra !== undefined) throw new Error(`Invalid repository "${repo}". Use owner/name.`);
        Object.assign(this, { owner, name, repo: `${owner}/${name}`, tokenProvider, apiUrl: apiUrl.replace(/\/+$/, ""), fetchImpl });
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

    async graphql(query, variables = {}) {
        const result = await this.request("POST", "/graphql", { query, variables });
        if (result?.errors?.length) throw new GitHubError(`GitHub GraphQL failed: ${result.errors.map((e) => e.message).join("; ")}`, 200);
        return result.data;
    }

    async login() {
        this.viewer ??= (await this.request("GET", "/user")).login;
        return this.viewer;
    }

    repoPath(suffix = "") {
        return `/repos/${this.owner}/${this.name}${suffix}`;
    }

    getRepo() {
        return this.request("GET", this.repoPath());
    }

    async unwatchRepo() {
        await this.request("DELETE", this.repoPath("/subscription"));
    }

    // GraphQL rather than REST: the REST issue list can lag several seconds behind issue creation,
    // which let concurrent sessions create duplicate channels and inboxes.
    async listOpenIssues() {
        const issues = [];
        let after = null;
        do {
            const data = await this.graphql(
                `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
                    issues(first: 100, after: $after, states: OPEN, orderBy: { field: CREATED_AT, direction: ASC }) {
                        pageInfo { hasNextPage endCursor } nodes { number title id url author { login } } } } }`,
                { owner: this.owner, name: this.name, after }
            );
            const connection = data.repository.issues;
            for (const node of connection.nodes) {
                issues.push({ number: node.number, title: node.title, node_id: node.id, html_url: node.url, user: { login: node.author?.login } });
            }
            after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
        } while (after);
        return issues;
    }

    createIssue(title, body) {
        return this.request("POST", this.repoPath("/issues"), { title, body });
    }

    async closeIssue(number) {
        await this.request("PATCH", this.repoPath(`/issues/${number}`), { state: "closed", state_reason: "not_planned" });
    }

    listComments(number, since) {
        const query = new URLSearchParams({ per_page: "100" });
        if (since) query.set("since", since);
        return this.paginate(this.repoPath(`/issues/${number}/comments?${query}`), { conditional: true });
    }

    async latestComment(number) {
        const issue = await this.request("GET", this.repoPath(`/issues/${number}`));
        if (!issue.comments) return null;
        const page = await this.request("GET", this.repoPath(`/issues/${number}/comments?per_page=1&page=${issue.comments}`));
        return page[0] ?? null;
    }

    createComment(number, body) {
        return this.request("POST", this.repoPath(`/issues/${number}/comments`), { body });
    }

    updateComment(id, body) {
        return this.request("PATCH", this.repoPath(`/issues/comments/${id}`), { body });
    }

    async deleteComment(id) {
        await this.request("DELETE", this.repoPath(`/issues/comments/${id}`));
    }

    async unsubscribeThread(nodeId) {
        await this.graphql(
            "mutation($id: ID!) { updateSubscription(input: { subscribableId: $id, state: UNSUBSCRIBED }) { clientMutationId } }",
            { id: nodeId }
        );
    }

    async aliveSocketUrl() {
        return (await this.request("GET", "/alive_internal/websocket-url")).url;
    }

    // Returns Map(issueNumber -> signed Alive channel) for the issues' UPDATED channel.
    async issueUpdateChannels(numbers) {
        const result = new Map();
        if (numbers.length === 0) return result;
        const fields = numbers.map((n) => `i${n}: issue(number: ${Number(n)}) { updatesChannel(name: UPDATED) }`).join("\n");
        const data = await this.graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, {
            owner: this.owner,
            name: this.name,
        });
        for (const n of numbers) {
            const channel = data?.repository?.[`i${n}`]?.updatesChannel;
            if (channel) result.set(Number(n), channel);
        }
        return result;
    }
}
