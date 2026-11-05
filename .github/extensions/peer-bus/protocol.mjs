// Wire format for peer-bus issues and comments. Pure functions; no I/O.

export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOGIN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const CHANNEL_TITLE = /^\[peer-bus\] channel: ([a-z0-9][a-z0-9._-]{0,63})$/;
const INBOX_TITLE = new RegExp(`^\\[peer-bus\\] inbox: @(${LOGIN})$`);
const ADDRESS = new RegExp(`^@?(${LOGIN})(?:/([A-Za-z0-9][A-Za-z0-9._-]{0,63}))?$`);
const MARKER = /<!--\s*peer-bus:v1\s+(\{[\s\S]*?\})\s*-->/g;

export const sameLogin = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export const sameSession = sameLogin;

export const channelTitle = (name) => `[peer-bus] channel: ${name}`;
export const inboxTitle = (login) => `[peer-bus] inbox: @${login}`;

export function parseTitle(title) {
    let match = CHANNEL_TITLE.exec(title ?? "");
    if (match) return { type: "channel", name: match[1] };
    match = INBOX_TITLE.exec(title ?? "");
    if (match) return { type: "inbox", login: match[1] };
    return null;
}

export function validateSessionName(name) {
    if (typeof name !== "string" || !SESSION_NAME.test(name)) {
        throw new Error(`Invalid session name "${name}". Use letters, digits, '.', '_' or '-' (max 64).`);
    }
    return name;
}

export function validateChannelName(name) {
    if (typeof name !== "string" || !CHANNEL_NAME.test(name)) {
        throw new Error(`Invalid channel name "${name}". Use lowercase letters, digits, '.', '_' or '-' (max 64).`);
    }
    return name;
}

export function parseAddress(text) {
    const trimmed = String(text ?? "").trim();
    if (trimmed === "*") return { kind: "all" };
    const match = ADDRESS.exec(trimmed);
    if (!match) throw new Error(`Invalid address "${text}". Use "login", "login/session", or "*".`);
    return match[2] ? { kind: "session", login: match[1], session: match[2] } : { kind: "person", login: match[1] };
}

export function formatAddress(address) {
    if (address.kind === "all") return "*";
    if (address.kind === "person") return address.login;
    return `${address.login}/${address.session}`;
}

function displayAddress(address) {
    if (address.kind === "all") return "everyone";
    if (address.kind === "person") return `@${address.login}`;
    return formatAddress(address);
}

function marker(meta) {
    return `<!-- peer-bus:v1 ${JSON.stringify(meta)} -->`;
}

export function encodeMessage({ login, from, to, kind, body }) {
    const header = `**${login}/${from}** → ${to.map(displayAddress).join(", ")}${kind === "notify" ? " · notify" : ""}`;
    return `${header}\n\n${body}\n\n${marker({ type: "message", from, to: to.map(formatAddress), kind })}`;
}

export function encodePresence({ login, session, sid, host, platform, channels, isDefault }) {
    const where = [host, platform].filter(Boolean).join(", ");
    const channelText = channels.length ? channels.map((c) => `#${c}`).join(", ") : "no channels";
    const text = `🟢 **${login}/${session}**${isDefault ? " (default)" : ""} is on the peer bus · ${where} · ${channelText}`;
    return `${text}\n\n${marker({ type: "presence", session, sid, host, platform, channels, default: isDefault })}`;
}

function lastMarker(body) {
    const matches = [...body.matchAll(MARKER)];
    if (matches.length === 0) return null;
    const last = matches.at(-1);
    try {
        return { meta: JSON.parse(last[1]), index: last.index };
    } catch {
        return null;
    }
}

// Parses an issue comment into { type: "message" | "presence" | "human", ... }.
// `defaultTo` is used for human comments without a marker.
export function parseComment(comment, defaultTo) {
    const author = comment.user?.login ?? "";
    const base = { id: comment.id, author, url: comment.html_url, createdAt: comment.created_at, updatedAt: comment.updated_at };
    const body = comment.body ?? "";
    const found = lastMarker(body);
    if (found?.meta?.type === "presence" && SESSION_NAME.test(found.meta.session ?? "")) {
        const { session, sid = "", host = "", platform = "", channels = [], default: isDefault = false } = found.meta;
        return {
            ...base,
            type: "presence",
            session,
            sid: String(sid),
            host: String(host),
            platform: String(platform),
            channels: Array.isArray(channels) ? channels.filter((c) => CHANNEL_NAME.test(c)) : [],
            isDefault: isDefault === true,
        };
    }
    if (found?.meta?.type === "message" && SESSION_NAME.test(found.meta.from ?? "")) {
        const to = [];
        for (const text of Array.isArray(found.meta.to) ? found.meta.to : []) {
            try {
                to.push(parseAddress(text));
            } catch {
                // ignore malformed addresses
            }
        }
        const beforeMarker = body.slice(0, found.index);
        const headerEnd = beforeMarker.indexOf("\n\n");
        const text = (headerEnd === -1 ? beforeMarker : beforeMarker.slice(headerEnd + 2)).trim();
        return { ...base, type: "message", from: found.meta.from, to, kind: found.meta.kind === "notify" ? "notify" : "task", body: text };
    }
    return { ...base, type: "human", from: null, to: defaultTo, kind: "task", body: body.trim() };
}

// me: { login, session, isDefault }
export function isAddressedTo(message, me) {
    if (sameLogin(message.author, me.login) && message.from && sameSession(message.from, me.session)) return false;
    return message.to.some(
        (address) =>
            address.kind === "all" ||
            (address.kind === "person" && sameLogin(address.login, me.login) && me.isDefault) ||
            (address.kind === "session" && sameLogin(address.login, me.login) && sameSession(address.session, me.session))
    );
}

export function senderAddress(message) {
    return message.from ? `${message.author}/${message.from}` : message.author;
}

const escapeAttr = (value) => String(value).replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);
const neutralize = (text) => text.replace(/<\/?peer_message/gi, (m) => m.replace("<", "&lt;"));

export function formatPrompt(messages, me, { omitted = 0 } = {}) {
    const blocks = messages.map((m) =>
        [
            `<peer_message where="${escapeAttr(m.where)}" from="${escapeAttr(senderAddress(m))}" to="${escapeAttr(m.to.map(formatAddress).join(", "))}" url="${escapeAttr(m.url)}">`,
            neutralize(m.body),
            "</peer_message>",
        ].join("\n")
    );
    const first = messages[0];
    const replyHint = first.channel
        ? `peer_send with channel="${first.channel}" and to="${senderAddress(first)}"`
        : `peer_send with to="${senderAddress(first)}"`;
    return [
        ...(omitted > 0 ? [`(${omitted} older peer message(s) were skipped during catch-up; see the issue for history.)`] : []),
        ...blocks,
        "",
        `${messages.length === 1 ? "This message was" : "These messages were"} delivered over the peer bus to you ("${me.login}/${me.session}") ` +
            `from a sender you trust. Handle ${messages.length === 1 ? "it" : "them"} as requests from a collaborating agent or person. ` +
            `To reply, use ${replyHint}. Do not send replies that are only acknowledgments.`,
    ].join("\n");
}
