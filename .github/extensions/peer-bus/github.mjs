// Minimal GitHub REST/GraphQL client for the peer bus. Dependency-free.

import { execFile } from "node:child_process";

import { issueKey } from "./protocol.mjs";

export class GitHubError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

const ENV_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN"];

// env without GH_TOKEN and GITHUB_TOKEN, so gh uses (and refreshes) its stored login.
export function withoutEnvTokens(env) {
    const stripped = { ...env };
    for (const name of ENV_TOKENS) delete stripped[name];
    return stripped;
}

// Resolves to the token `gh auth token` prints with the given environment, or null if it has none.
export function ghAuthToken(env) {
    return new Promise((resolve) => {
        execFile("gh", ["auth", "token", "--hostname", "github.com"], { env, timeout: 10_000 }, (error, stdout) => {
            resolve((!error && stdout?.trim()) || null);
        });
    });
}

// gh prefers GH_TOKEN/GITHUB_TOKEN over its stored login, and the GitHub Copilot app sets GH_TOKEN for
// sessions to a token that lacks the notifications scope. So read the stored login, which is the one
// `gh auth refresh -s notifications` updates, and fall back to the environment token only without one.
export async function ghCliToken({ env = process.env, run = ghAuthToken } = {}) {
    const token = (await run(withoutEnvTokens(env))) ?? (ENV_TOKENS.some((name) => env[name]) ? await run(env) : null);
    if (!token) {
        const error = new Error("Could not get a GitHub token from the GitHub CLI. Install gh and run `gh auth login`.");
        error.noToken = true;
        throw error;
    }
    return token;
}

export function defaultTokenProvider(env = process.env) {
    return env.PEER_BUS_GITHUB_TOKEN ? async () => env.PEER_BUS_GITHUB_TOKEN : () => ghCliToken({ env });
}

const MINUTE = 60_000;

// How long to wait before retrying a rate-limited request, or null if the response isn't a rate limit.
// Follows GitHub's guidance: honor Retry-After, wait for the reset when the primary limit is exhausted,
// and otherwise back off at least a minute (exponentially) for secondary limits.
export function rateLimitDelay(status, headers, message, attempt, now = Date.now()) {
    if (status !== 403 && status !== 429) return null;
    const retryAfter = Number(headers.get("retry-after"));
    if (retryAfter > 0) return retryAfter * 1000;
    if (headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(headers.get("x-ratelimit-reset"));
        if (reset > 0) return Math.max(reset * 1000 - now, 0) + 1000;
    }
    if (status === 429 || /rate limit|abuse/i.test(message ?? "")) return MINUTE * 2 ** attempt;
    return null;
}

function nextLink(header) {
    return /<([^>]+)>;\s*rel="next"/.exec(header ?? "")?.[1] ?? null;
}

export class GitHub {
    // maxRateLimitWaitMs caps the total time one request waits out rate limits before failing.
    constructor({
        tokenProvider = defaultTokenProvider(),
        apiUrl = "https://api.github.com",
        fetchImpl = globalThis.fetch,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onRateLimit = () => {},
        maxRateLimitWaitMs = 3 * MINUTE,
    } = {}) {
        Object.assign(this, { tokenProvider, apiUrl: apiUrl.replace(/\/+$/, ""), fetchImpl, sleep, onRateLimit, maxRateLimitWaitMs });
        this.token = null;
        this.etags = new Map();
        this.viewer = null;
        this.scopes = null; // Set of OAuth scopes when GitHub reports them (classic and OAuth tokens only)
    }

    async authHeader(refresh = false) {
        if (!this.token || refresh) this.token = await this.tokenProvider();
        return `Bearer ${this.token}`;
    }

    // Rereads the token, whose scopes may have changed since it was read, and learns its scopes.
    async reauthenticate() {
        this.token = await this.tokenProvider();
        this.scopes = null;
        await this.raw("GET", "/user");
    }

    // Returns { status, data, link }. Waits out rate limits (up to maxRateLimitWaitMs in total), then throws
    // GitHubError for non-2xx/304 responses.
    async raw(method, pathOrUrl, options = {}) {
        let waited = 0;
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.rawOnce(method, pathOrUrl, { ...options, attempt });
            } catch (error) {
                const delay = error.rateLimitDelay;
                if (delay === undefined || delay === null) throw error;
                if (waited + delay > this.maxRateLimitWaitMs) {
                    error.message += ` GitHub rate limit: try again after ${new Date(Date.now() + delay).toLocaleTimeString()}.`;
                    throw error;
                }
                waited += delay;
                this.onRateLimit(delay);
                await this.sleep(delay);
            }
        }
    }

    async rawOnce(method, pathOrUrl, { body, conditional = false, attempt = 0 } = {}) {
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
            const message = data?.message ?? `HTTP ${response.status}`;
            const error = new GitHubError(`GitHub ${method} ${url.replace(this.apiUrl, "")} failed: ${message}`, response.status);
            error.rateLimitDelay = rateLimitDelay(response.status, response.headers, message, attempt);
            throw error;
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

    async getIssue(ref, { conditional = false } = {}) {
        return (await this.raw("GET", this.issuePath(ref), { conditional })).data;
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

    listReactions(repo, commentId, content) {
        return this.paginate(`/repos/${repo}/issues/comments/${commentId}/reactions?content=${content}&per_page=100`, { conditional: true });
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
