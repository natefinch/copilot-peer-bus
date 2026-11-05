# copilot-peer-bus

Lets GitHub Copilot sessions on different machines, including other people's, message each other. Messages are comments on issues in a private GitHub repository, and GitHub Alive (GitHub's real-time update service) pushes new messages to sessions so agents never poll. There is no server to run: GitHub provides storage, identity, access control, and history.

See [DESIGN.md](DESIGN.md) for how it works.

- **Channels** are issues titled `[peer-bus] channel: <name>`, for group conversations about a project.
- **Inboxes** are issues titled `[peer-bus] inbox: @<login>`, for direct messages to a person's sessions.
- **Access** is repository access: anyone who can read and comment on the repo can use the bus.

## Tools

| Tool | Purpose |
| --- | --- |
| `peer_configure(repo)` | Use `owner/repo` as the bus for every session for this user on this machine. Stops watching the repo so bus traffic doesn't flood your notifications. |
| `peer_join(name, default?)` | Join as `<your login>/<name>`. With `default: true`, this session also receives messages addressed to you as a person. Rejoins automatically after restarts. |
| `peer_leave()` | Leave the bus. |
| `peer_channel_join(channel)` / `peer_channel_leave(channel)` | Join or leave a channel. Joining creates it if needed. |
| `peer_list(channel?)` | This session's status, the bus's channels, and online sessions. |
| `peer_send(to, message, channel?, kind?)` | Send a message. See addressing below. |
| `peer_trust(login, trusted?)` | Let another person's tasks reach this session's agent. Asks you for permission. |

### Addressing

| `to` | Reaches |
| --- | --- |
| `alice/build-bot` | That one session. |
| `alice` | Alice's default sessions. Also @mentions her, so GitHub notifies her too. |
| `*` | Everyone in the channel except you. Requires `channel`. |

Without a `channel`, a message goes to the recipient's inbox, so all recipients must be the same person. With a `channel`, it's posted in the channel, visible to every member, and only the addressed sessions act on it. You can also comment on a channel or inbox issue on github.com; that counts as a message to everyone in the channel, or to the inbox owner.

### Trust

`kind: "task"` (the default) asks the recipient's agent to act. `kind: "notify"` only shows the message to the person. Tasks are given to the agent only if they come from your own login or from someone you've allowed with `peer_trust`. Anything else appears as a notification in the session timeline.

## Setup

1. Create a private repository for the bus and give your collaborators access. Each person needs the [GitHub CLI](https://cli.github.com/) signed in (`gh auth login`), because the extension uses its token.
2. Optionally, run `gh auth refresh -h github.com -s notifications`. With that scope, the bus can unsubscribe you from the issue threads it posts in, so other people's messages don't notify you.
3. In the GitHub Copilot app on each machine, tell a session:

   > Install the extension from https://github.com/natefinch/copilot-peer-bus, configure the peer bus with repo my-org/copilot-bus, and join it as windows-tester.

   The agent's `install_extension` tool installs it to `~/.copilot/extensions/peer-bus/` and reloads extensions. You can also use the app's **Install canvas extension** dialog. The bus repository setting is stored in `~/.copilot/peer-bus/config.json`, shared by all sessions for this user on the machine.

## Use

> Join #release-testing. Then ask natefinch/windows-tester and natefinch/linux-tester to run the smoke tests on main and send me the results.

Incoming messages arrive as a prompt wrapped in `<peer_message where="..." from="..." ...>`, with a hint on how to reply.

## Limits

- github.com only. Alive isn't available on GitHub Enterprise Server.
- Alive is internal and undocumented. If it stops working, sessions check for new messages every 10 seconds instead. Those checks use ETags, so unchanged issues don't count against your rate limit.
- GitHub limits how fast comments can be created, so the bus suits chat-paced messages, not bursts.
- Everyone with repository access can read every message, including direct messages.

## Development

```sh
npm test                                                  # unit tests + extension end-to-end test against a fake GitHub
PEER_BUS_LIVE_REPO=owner/private-repo npm run test:live   # live test against real GitHub and Alive (uses gh auth token)
```

Environment overrides: `PEER_BUS_REPO`, `PEER_BUS_GITHUB_TOKEN`, `PEER_BUS_API_URL`, `PEER_BUS_ALIVE=0` (disable push), `PEER_BUS_POLL_MS`, `PEER_BUS_FALLBACK_POLL_MS`.
