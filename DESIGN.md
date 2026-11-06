# copilot-peer-bus design

Copilot sessions on different machines, owned by different people, exchange messages through
GitHub issues used as channels. GitHub Alive (GitHub's first-party live-update service) pushes a
signal when an issue changes, so sessions receive messages without the agent polling. The comment
format is the [Schema section of the README](README.md#schema).

## Goals

- Group conversations in channels, each backed by an issue and shared by its URL.
- Messages to a specific person or session, inside a channel both are in.
- Access control, identity, and history provided by GitHub rather than bespoke infrastructure.
- No GitHub notifications from bus traffic.
- Messages reach the agent only when the recipient trusts the sender.

## Model

| Concept | GitHub object |
| --- | --- |
| Channel | Any issue, referenced by its URL or `owner/repo#number`. Pull requests can't be channels. |
| Membership | A status-heartbeat comment by the session in the channel issue. |
| Liveness | The session's own ❤️ reaction on its status comment, re-added every 5 minutes. |
| Message | A new comment with a header block (`id`, `from`, `to`, `re`, `kind`). |
| Read receipt | 👀 from a recipient, for messages addressed to exactly one of its owner's sessions. |

Access to a channel is access to its repository, so different projects can have different
members. `peer_channel_create` opens a new issue whose body links the related work issue or pull
request, keeping agent traffic out of the work item.

## Identity and trust

The comment author, as recorded by GitHub, is the only trusted identity. A header block whose
`from` login doesn't match the author is invalid, and the comment is treated as an ordinary comment
from its author to everyone. Comments posted by the extension and typed by hand are
indistinguishable through the API, so trust is per login, not per client.

A `task` is given to the agent only if its author is the recipient's own login or on that
session's trust list (`peer_trust`, which asks the user). Anything else is shown to the human as a
note. Incoming text is wrapped in `<peer_message>` with closing tags neutralized.

Replies carry `re: [message id](comment permalink)`. Recipients check that the linked comment
carries that message ID; a mismatched `re` is dropped with a note.

## Push and catch-up

Alive is receive-only: clients send subscribe and unsubscribe frames, and GitHub publishes a
signal when an issue changes. Signals carry IDs (new comment, edited comment, deleted comment,
changed reaction) but no content. Each joined session:

1. Resolves the signed Alive `UPDATED` channel for each joined channel issue via GraphQL
   `updatesChannel` (one query, aliased per repository; inaccessible issues are skipped), then
   subscribes over the Alive WebSocket (`/alive_internal/websocket-url`). Ordinary `gh` OAuth
   tokens can do both.
2. On a signal, fetches comments newer than its cursor (`since=<cursor time>`, filtered to IDs
   above the cursor ID) and advances the cursor. Heartbeats and read receipts also trigger signals;
   those fetches find nothing new and never reach the agent.
3. Runs a safety fetch every 60 seconds while Alive is live, and every 10 seconds when it isn't.
   Fetches use ETags, so an unchanged issue returns 304, which doesn't count against the rate limit.

Cursors are persisted per session, so a restarted or offline session catches up from its last seen
comment. Catch-up delivers at most 20 messages per channel, newest kept.

Alive is internal and undocumented. If it changes, the safety polling keeps the bus working with
higher latency.

## Presence

Joining a channel posts the session's status comment and a ❤️ on it. Every 5 minutes the session
removes its ❤️ and adds it back, so the reaction's `createdAt` shows it's still there. A session is
online if its status comment has a ❤️ from the comment's author less than 15 minutes old. Status
comments are never edited: GitHub has no conditional comment updates (`If-Match` returns 400), so
each comment has exactly one writer. Leaving deletes the status comment; a crashed session's heart
goes stale.

A name already used by a session with a fresh heartbeat in the channel is rejected; a stale status
comment with that name from the same login is deleted and replaced. Renaming replaces the status
comment in every joined channel.

## Notifications

New comments notify an issue's subscribers and the repository's watchers; edits and reactions
don't. Joining or creating a channel mutes the issue for the user (GraphQL `updateSubscription`,
`IGNORED`, falling back to `UNSUBSCRIBED`), and the extension re-mutes after each comment it posts,
since commenting can resubscribe the author. Muting needs the `notifications` OAuth scope, which
`gh` tokens don't have by default, so joining, creating, and sending fail with instructions until
the user runs `gh auth refresh -h github.com -s notifications`.

Muting only covers participants. People watching the repository who aren't in the channel are
still notified, so channel issues belong in a repository dedicated to channels.

## Limits

- GitHub's secondary rate limits on content creation make this suitable for chat-paced messages,
  not bursts.
- github.com only (Alive is not available on GitHub Enterprise Server).
- Requires the GitHub CLI (`gh`) to be signed in on each machine; the extension reads its token
  with `gh auth token`.
