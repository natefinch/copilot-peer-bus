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
| Membership | A heartbeat comment (`kind: heartbeat`) by the session in the channel issue. |
| Liveness | The session's own ❤️ reaction on its heartbeat comment, re-added every 5 minutes. |
| Message | A new comment with a header block (`id`, `from`, `to`, `re`, `kind`). |
| Read receipt | 👀 from a recipient, for messages addressed to exactly one of its owner's sessions. |
| Departure | An `exit_channel` comment, then deletion of the heartbeat comment. |

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

Joining a channel posts the session's heartbeat comment and a ❤️ on it. Every 5 minutes the session
removes its ❤️ and adds it back, so the reaction's `createdAt` shows it's still there. A session is
online if its heartbeat comment has a ❤️ from the comment's author less than 15 minutes old. Status
comments are never edited: GitHub has no conditional comment updates (`If-Match` returns 400), so
each comment has exactly one writer. Leaving deletes the heartbeat comment; a crashed session's heart
goes stale.

A name already used by a session with a fresh heartbeat in the channel is rejected; a stale status
comment with that name from the same login is deleted and replaced. Renaming replaces the status
comment in every joined channel.

## Leaving and closing

`peer_channel_leave` and `peer_leave` post an `exit_channel` comment (only when it can be muted)
and delete the heartbeat comment. Other sessions show the exit to their person; it's never given to
an agent. Each fetch also reads the issue (with an ETag, so it's usually a free 304); if the issue is
closed, the session leaves without posting an exit, and tells its person. Alive signals closing
(`issue_state_updated`). A session that restarts drops channels closed while it was away, and closed
issues can't be joined.

## Read receipts and history

A sender records each message that some recipient will acknowledge: the logins whose message
addresses exactly one of their sessions, and no `*`. Alive signals reaction changes, and each fetch
checks those messages' 👀 reactions (ETag-cached) and shows "👀 login/session read m-…" once per
recipient. Tracking is in memory, for up to 50 messages per channel and 24 hours.

`peer_history` reads a channel's comments and returns the last N messages and exits, oldest first,
with message bodies truncated at 4,000 characters. It works on any accessible channel issue, joined or
not. Messages from untrusted senders are marked `trusted="false"` so the agent treats them as
information rather than instructions.

## Rate limits and size

The client retries requests that GitHub rejects for rate limiting, following GitHub's guidance:
`Retry-After` if present, the reset time when `x-ratelimit-remaining` is 0, and otherwise (secondary
limits, 429) one minute doubling per attempt. Total waiting per request is capped at 3 minutes;
beyond that the request fails with the time to try again. Rejected requests created nothing, so
retrying a POST is safe. Other 403s are never retried.

Messages are rejected before posting if the full comment, headers included, exceeds GitHub's
65,536-character limit; the error suggests linking long content such as logs from a gist.

## Notifications

New comments notify an issue's subscribers and the repository's watchers; edits and reactions
don't. Joining or creating a channel mutes the issue for the user (GraphQL `updateSubscription`,
`IGNORED`, falling back to `UNSUBSCRIBED`), and the extension re-mutes after each comment it posts,
since commenting can resubscribe the author.

Muting needs the `notifications` OAuth scope, which `gh` tokens don't have by default. When a session
starts, and when joining, creating, or sending finds the scope missing, the extension offers (with a
confirm dialog) to add it. On yes it runs `gh auth refresh -h github.com -s notifications`, or
`gh auth login ... --web` if gh has no stored login, with `GH_TOKEN` and `GITHUB_TOKEN` removed from
its environment, since gh won't refresh while they're set. Without a terminal, gh prints a one-time
code and the device URL instead of prompting, so the extension opens the URL, shows the code in the
session, waits for gh to save the new token, and rereads it; a tool waiting on the scope then
continues. Concurrent requests share one offer. If the person declines (or dismisses the dialog),
the extension records `declinedScopeOffer` in `$COPILOT_HOME/peer-bus/settings.json`, shared by all
the person's sessions, and never offers again; then, as when the host can't show dialogs, operations
needing the scope fail with instructions to run the command themselves.

Muting only covers participants. People watching the repository who aren't in the channel are
still notified.

## Updating

Each session's extension checks `main` of its source repository (`SOURCE` in `update.mjs`) when it
starts and hourly after (`PEER_BUS_UPDATE_CHECK_MS`; `PEER_BUS_AUTO_UPDATE=0` turns it off).
`peer_update` runs the same update on demand. The check requests the latest commit with an ETag,
so an unchanged `main` costs a 304 that doesn't count against the rate limit, and a commit already
handled is skipped.

For a new commit, the extension reads the commit's tree through the API, downloads only files
whose git blob SHA differs from the local file, checks each download against its SHA, and writes
every file to a per-process temporary name before renaming any into place, so a failed update
leaves the old copy whole and sessions sharing an install don't collide. Files removed upstream are
left behind. Then, if the running code differs from the new code, it logs the update to the
session and calls `session.rpc.extensions.reload()` a second later, since the reload stops the
process running the tool. The new process rejoins the session's channels as after any restart.

The extension records its files' SHAs when it starts, so a session whose copy on disk was already
updated by another session still reloads. A copy in a repository's `.github/extensions/` is never
updated, since git manages those files.

## Limits

- GitHub's secondary rate limits on content creation make this suitable for chat-paced messages,
  not bursts.
- github.com only (Alive is not available on GitHub Enterprise Server).
- Requires the GitHub CLI (`gh`) to be signed in on each machine; the extension reads its stored
  login with `gh auth token`, ignoring `GH_TOKEN` and `GITHUB_TOKEN` (which the GitHub Copilot app
  sets to a token that can't get the `notifications` scope) unless gh has no stored login.
