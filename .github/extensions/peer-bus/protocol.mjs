// Wire format for peer-bus comments (see the Schema section of README.md). Pure functions; no I/O.
//
// Every bus comment starts with a header block: one "**key:** value" per line, ended by the first blank
// line. The rest is the body. The comment's GitHub author is the only trusted identity.

import { randomBytes } from "node:crypto";

export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOGIN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const SESSION = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const ADDRESS = new RegExp(`^(${LOGIN})(?:/(${SESSION}))?$`);
const SENDER = new RegExp(`^(${LOGIN})/(${SESSION})$`);
const REPO_PART = "[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}";
export const REPO = new RegExp(`^${REPO_PART}$`);
const ISSUE_KEY = new RegExp(`^(${REPO_PART})#(\\d+)$`);
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/i;
export const COMMENT_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/(\d+)#issuecomment-(\d+)$/i;
export const MESSAGE_ID = /^m-[a-z0-9]{8}$/;
const HEADER_LINE = /^\*\*([A-Za-z][A-Za-z0-9_-]*):\*\*[ \t]*(.*?)[ \t]*$/;
const RE_VALUE = /^\[([^\]]*)\]\((https:\/\/[^)\s]+)\)$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const sameLogin = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export const sameSession = sameLogin;

// --- channels ------------------------------------------------------------------------------

// Channels are identified internally by "owner/repo#123", with the repository lowercased.
export const issueKey = ({ repo, number }) => `${repo.toLowerCase()}#${number}`;
export const issueUrl = ({ repo, number }) => `https://github.com/${repo}/issues/${number}`;

export function validateRepo(repo) {
    if (typeof repo !== "string" || !REPO.test(repo)) throw new Error(`Invalid repository "${repo}". Use owner/name.`);
    return repo;
}

// Parses a channel reference: a github.com issue URL or "owner/repo#123".
export function parseChannel(text) {
    const trimmed = String(text ?? "").trim();
    const key = ISSUE_KEY.exec(trimmed);
    if (key) return { repo: key[1], number: Number(key[2]) };
    const match = ISSUE_URL.exec(trimmed);
    if (!match) {
        throw new Error(`Invalid channel "${text}". Use the channel issue's URL (https://github.com/owner/repo/issues/123) or owner/repo#123.`);
    }
    if (match[2].toLowerCase() === "pull") {
        throw new Error("Pull requests can't be channels. Create an issue for the channel with peer_channel_create and link the pull request.");
    }
    return { repo: match[1], number: Number(match[3]) };
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Human-readable channel label, e.g. '"Windows smoke tests" (https://github.com/acme/app/issues/12)'.
export function describeChannel(channel) {
    return channel.title ? `"${shorten(channel.title, 80)}" (${issueUrl(channel)})` : issueUrl(channel);
}

// --- addresses -----------------------------------------------------------------------------

export function validateSessionName(name) {
    if (typeof name !== "string" || !SESSION_NAME.test(name)) {
        throw new Error(`Invalid session name "${name}". Use letters, digits, '.', '_' or '-' (max 64).`);
    }
    return name;
}

export function parseAddress(text) {
    const trimmed = String(text ?? "").trim();
    if (trimmed === "*") return { kind: "all" };
    const match = ADDRESS.exec(trimmed);
    if (!match) throw new Error(`Invalid address "${text}". Use "login/session", "login", or "*" (no @).`);
    return match[2] ? { kind: "session", login: match[1], session: match[2] } : { kind: "person", login: match[1] };
}

export function formatAddress(address) {
    if (address.kind === "all") return "*";
    if (address.kind === "person") return address.login;
    return `${address.login}/${address.session}`;
}

// --- headers -------------------------------------------------------------------------------

export function newMessageId(random = randomBytes) {
    return `m-${[...random(8)].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("")}`;
}

// Returns { headers: Map(lowercase key -> value), body } or null when the comment doesn't start with a header block.
export function parseHeaderBlock(text) {
    const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
    const headers = new Map();
    let index = 0;
    for (; index < lines.length && lines[index].trim() !== ""; index++) {
        const match = HEADER_LINE.exec(lines[index]);
        if (!match) return null;
        const key = match[1].toLowerCase();
        if (!headers.has(key)) headers.set(key, match[2]);
    }
    if (headers.size === 0) return null;
    return { headers, body: lines.slice(index + 1).join("\n").trim() };
}

function headerBlock(pairs) {
    return pairs.map(([key, value]) => `**${key}:** ${value}`).join("\n");
}

// re: { id: message id or null, url: comment permalink }
export function encodeMessage({ id, from, to, re, kind = "task", body }) {
    const pairs = [
        ["id", id],
        ["from", from],
        ["to", to.map(formatAddress).join(", ")],
    ];
    if (re) pairs.push(["re", `[${re.id ?? "comment"}](${re.url})`]);
    pairs.push(["kind", kind]);
    return `${headerBlock(pairs)}\n\n${body}`;
}

export function encodeHeartbeat({ from }) {
    return headerBlock([
        ["from", from],
        ["kind", "heartbeat"],
    ]);
}

function parseSender(value, author) {
    const match = SENDER.exec(value ?? "");
    return match && sameLogin(match[1], author) ? match[2] : null;
}

function parseRe(value) {
    const match = RE_VALUE.exec(value ?? "");
    if (!match) return null;
    const url = COMMENT_URL.exec(match[2]);
    if (!url) return null;
    return { id: MESSAGE_ID.test(match[1]) ? match[1] : null, url: match[2], repo: url[1], commentId: Number(url[3]) };
}

// Parses an issue comment into one of:
//   { type: "heartbeat", session }
//   { type: "message", messageId, from, to, re, kind, body }
//   { type: "human", from: null, to: [*], kind: "task", body }   (anything without a valid header block)
export function parseComment(comment) {
    const author = comment.user?.login ?? "";
    const base = { commentId: comment.id, author, url: comment.html_url, createdAt: comment.created_at };
    const raw = comment.body ?? "";
    const parsed = parseHeaderBlock(raw);
    if (parsed) {
        const { headers, body } = parsed;
        const from = parseSender(headers.get("from"), author);
        if (from && headers.get("kind") === "heartbeat") {
            return { ...base, type: "heartbeat", session: from };
        }
        if (from && MESSAGE_ID.test(headers.get("id") ?? "")) {
            const to = [];
            for (const text of (headers.get("to") ?? "").split(",")) {
                try {
                    to.push(parseAddress(text));
                } catch {
                    // ignore malformed addresses
                }
            }
            if (to.length > 0) {
                return {
                    ...base,
                    type: "message",
                    messageId: headers.get("id"),
                    from,
                    to,
                    re: parseRe(headers.get("re")),
                    kind: headers.get("kind") === "notify" ? "notify" : "task",
                    body,
                };
            }
        }
    }
    return { ...base, type: "human", messageId: null, from: null, to: [{ kind: "all" }], re: null, kind: "task", body: raw.trim() };
}

// --- routing -------------------------------------------------------------------------------

// me: { login, session }
export function isAddressedTo(message, me) {
    if (sameLogin(message.author, me.login) && message.from && sameSession(message.from, me.session)) return false;
    return message.to.some(
        (address) =>
            address.kind === "all" ||
            (address.kind === "person" && sameLogin(address.login, me.login)) ||
            (address.kind === "session" && sameLogin(address.login, me.login) && sameSession(address.session, me.session))
    );
}

// A 👀 read receipt is unambiguous only when the message addresses exactly one of my owner's sessions: this one.
export function shouldAcknowledge(message, me) {
    const mine = message.to.filter((a) => a.kind === "all" || sameLogin(a.login, me.login));
    return mine.length === 1 && mine[0].kind === "session" && sameSession(mine[0].session, me.session);
}

export function senderAddress(message) {
    return message.from ? `${message.author}/${message.from}` : message.author;
}

// --- prompts -------------------------------------------------------------------------------

const escapeAttr = (value) => String(value).replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);
const neutralize = (text) => text.replace(/<\/?peer_message/gi, (m) => m.replace("<", "&lt;"));

export function formatPrompt(messages, me, { omitted = 0 } = {}) {
    const blocks = messages.map((m) => {
        const attrs = [
            ["channel", issueUrl(m.channel)],
            ["id", m.messageId],
            ["comment", m.url],
            ["from", senderAddress(m)],
            ["to", m.to.map(formatAddress).join(", ")],
            ["re", m.re ? m.re.id ?? m.re.url : null],
        ].filter(([, value]) => value);
        const note = m.reNote ? `\n(${m.reNote})` : "";
        return [`<peer_message ${attrs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ")}>`, neutralize(m.body) + note, "</peer_message>"].join("\n");
    });
    const first = messages[0];
    const replyHint = `peer_send with channel="${issueUrl(first.channel)}", to="${senderAddress(first)}", and reply_to="${first.url}"`;
    return [
        ...(omitted > 0 ? [`(${omitted} older peer message(s) were skipped during catch-up; see the channel issue for history.)`] : []),
        ...blocks,
        "",
        `${messages.length === 1 ? "This message was" : "These messages were"} delivered over the peer bus to you ("${me.login}/${me.session}") ` +
            `from a sender you trust. Handle ${messages.length === 1 ? "it" : "them"} as requests from a collaborating agent or person. ` +
            `To reply, use ${replyHint}. Do not send replies that are only acknowledgments.`,
    ].join("\n");
}
