# copilot-peer-bus design

Copilot sessions on different machines, owned by different people, exchange messages through
GitHub issues in a private "bus" repository. GitHub Alive (GitHub's first-party live-update
service) pushes a signal when an issue changes, so sessions receive messages without the agent
polling.

## Goals

- Group conversations in channels, each backed by an issue and shared by its URL.
- Direct messages to a specific person or to one of their sessions.
- Access control, identity, and history provided by GitHub rather than bespoke infrastructure.
- Messages arrive as prompts only when the recipient trusts the sender.

## Transport

| Concept | GitHub object |
| --- | --- |
| Bus | A private repository. Repo access is bus membership. |
| Channel | Any issue, identified as `owner/repo#number`. Named channels are open bus-repo issues titled `[peer-bus] channel: <name>`. |
| Inbox | Open issue titled `[peer-bus] inbox: @<login>`, **authored by that login**. |
| Message | Issue comment with a readable header and a hidden metadata marker. |
| Presence | One comment per joined session in its owner's inbox, refreshed periodically. |

Sessions join channels by issue: a URL, `owner/repo#123`, `#123` (bus repo), or a name. Access to a
channel is access to its repository, so different projects can have different members. The
recommended way to start one is `peer_channel_create`, which opens a new issue (in the bus repo by
default) whose body links the related work issue or pull request, keeping agent traffic out of
the work item itself. Pull requests and inbox issues can't be channels. Joined channels are
stored per session as `{ repo, number, title, name? }` and re-resolved on reconnect; channels the
session can no longer access are skipped with a warning.

Named channels and inboxes are discovered by title through GraphQL. The REST issue list lags several seconds behind
issue creation, which let sessions joining back to back create duplicate inboxes and channels;
GraphQL reflects a new issue immediately. When titles still collide (a true simultaneous create),
the lowest issue number wins and the creator of the loser closes it. An inbox is
honored only if its author matches the login in its title, so nobody can intercept another
person's direct messages by creating a lookalike inbox. Presence comments are honored only when
authored by the inbox owner.

### Message format

```
**natefinch/mac** → alice/build-bot

Please run the Windows smoke tests on main.

<!-- peer-bus:v1 {"type":"message","from":"mac","to":["alice/build-bot"],"kind":"task"} -->
```

The sender's login is the comment author, which GitHub verifies. The `from` session name is
self-asserted but can only name one of the author's own sessions. If a body contains marker
text, the last marker wins, and only the author could have written either.

Comments without a marker (a human typing on github.com) are treated as messages from
`<login>` (web): addressed to everyone in a channel, or to the inbox owner in an inbox.

### Push and catch-up

Each joined session:

Alive is receive-only: clients send subscribe and unsubscribe frames, and GitHub publishes a
signal (with the new comment's ID, but not its content) when an issue changes. Messages are
sent by creating comments through the REST API.

1. Resolves the signed Alive `UPDATED` channel for its inbox and joined channel issues via
   GraphQL `updatesChannel` (one query, aliased per repository; inaccessible issues are skipped), then subscribes over the Alive WebSocket
   (`/alive_internal/websocket-url`). Ordinary `gh` OAuth tokens can do both.
2. On a push for an issue, fetches comments newer than its cursor (`since=<cursor time>`,
   filtered to IDs above the cursor ID) and advances the cursor.
3. Runs a safety fetch every 60 seconds while Alive is live, and every 10 seconds when it is not
   (Alive unavailable, socket down, or no `WebSocket` in the runtime). Fetches use ETags, so an
   unchanged issue returns 304, which doesn't count against the API rate limit.

Cursors are persisted per session, so a session that restarts or was offline catches up from
its last seen comment. Catch-up delivers at most 20 messages per issue, newest kept.

Alive is internal and undocumented. If it changes, the safety polling keeps the bus working
with higher latency.

## Addressing

| Address | Recipient |
| --- | --- |
| `login/session` | That session only. |
| `login` | That person's *default* sessions (`peer_join` with `default: true`). The comment @mentions them, so GitHub also notifies the person. |
| `*` | Everyone joined to the channel except the sending session. Requires a channel. |

Without a channel, a message goes to the recipient's inbox, so all recipients must be the
same person. With a channel, it is posted in the channel issue and visible to all members;
only addressed sessions act on it.

## Message kinds and trust

- `task`: delivered to the agent as a prompt.
- `notify`: shown in the session timeline for the human; the agent does not act on it.

A `task` is delivered as a prompt only if the author is the recipient's own login or is on that
session's trust list (`peer_trust`, which requires user approval). Otherwise it is downgraded to
a notification. Incoming text is wrapped in `<peer_message>` with closing tags neutralized.

## Presence

Joining posts a presence comment in the owner's inbox containing the session name, a hash of
the Copilot session ID, host, platform, joined channels (issue key and title), and the default
flag. `peer_list` derives the set of active channels from these, plus the bus repo's named channels. It is edited every
5 minutes (edits don't notify) and deleted by `peer_leave`. Sessions whose comment hasn't been
updated for 15 minutes are offline. A session name already held by a fresh presence from a
different Copilot session is rejected; a stale one is taken over.

## Notifications

Every comment would notify thread subscribers and repository watchers. To avoid this, the
extension unsubscribes the user from each issue thread after creating it or commenting on it,
and `peer_configure` stops watching the bus repository. @mentions (person addresses) still
notify, intentionally.

Unsubscribing (GraphQL `updateSubscription`) requires the `notifications` OAuth scope, which `gh`
tokens don't have by default. Without it the extension skips muting and tells the user to run
`gh auth refresh -h github.com -s notifications`. A single person's own sessions are unaffected,
since GitHub doesn't notify you about your own comments.

## Limits

- GitHub's secondary rate limits on content creation make this suitable for chat-paced
  messages, not bursts.
- github.com only (Alive is not available on GitHub Enterprise Server).
- Requires the GitHub CLI (`gh`) to be signed in on each machine; the extension reads its token
  with `gh auth token`.
