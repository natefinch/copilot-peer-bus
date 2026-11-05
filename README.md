# copilot-peer-bus

Lets GitHub Copilot sessions on different machines send each other messages. You run one small relay (for example in Docker on your LAN). A Copilot extension on each machine connects the sessions that join and delivers incoming messages to the session as new prompts, so agents never have to poll.

```
 machine A (session "mac")          relay (Docker)          machine B (session "windows-tester")
 peer_send(to="windows-tester") ──► POST /send ──► SSE /events ──► session.send(prompt)
```

- **Relay** (`relay/server.mjs`): a dependency-free Node HTTP server. Peers stay connected with Server-Sent Events. It routes direct and broadcast messages, and queues direct messages to offline peers (up to 100 per peer for one hour, kept in memory).
- **Extension** (`.github/extensions/peer-bus/`): a standard Copilot session extension with five tools:

| Tool | Purpose |
| --- | --- |
| `peer_configure(url, token)` | Save the relay URL and token for every session for this user on this machine. |
| `peer_join(name)` | Join the bus as `name`. The session auto-rejoins with this name after restarts. |
| `peer_leave()` | Leave the bus. The session no longer auto-rejoins. |
| `peer_list()` | List connected peers with their hostname and OS platform. |
| `peer_send(to, message)` | Send to a peer, or use `"*"` to broadcast to every other peer. |

Joining is opt-in. The extension loads in every session on a machine, but only sessions that call `peer_join` connect to the relay. Peer names are unique: if a second session joins with a name that's already in use, the first session is told it was replaced and stops reconnecting.

## 1. Run the relay

On one machine that every other machine can reach:

```sh
echo "PEER_BUS_TOKEN=$(openssl rand -hex 24)" > .env
docker compose up -d --build
curl http://localhost:7777/healthz   # {"ok":true}
```

Without Docker: `PEER_BUS_TOKEN=... node relay/server.mjs` (Node 18+). `PORT` and `HOST` are also configurable.

## 2. Set up each machine

In the GitHub Copilot app on each machine, send a session:

> Install the extension from https://github.com/natefinch/copilot-peer-bus, then configure the peer bus with url http://&lt;relay-ip&gt;:7777 and token &lt;token&gt;, and join it as windows-tester.

The agent's `install_extension` tool installs the extension for your user (`~/.copilot/extensions/peer-bus/`) and reloads extensions. You can also install from the app's **Install canvas extension** dialog. `peer_configure` writes `~/.copilot/peer-bus/config.json`, which every session for this user on the machine shares. The `PEER_BUS_URL` and `PEER_BUS_TOKEN` environment variables override it. Both paths respect `COPILOT_HOME`.

Sessions opened in this repository also load the extension directly from `.github/extensions/peer-bus/` (after you trust the repository), which is convenient while developing it.

## 3. Use it

From any machine:

> Use peer_list to see who's online, then ask each tester to build the app, run the smoke tests, and send the results back to me.

Incoming messages show up in the recipient session as a prompt wrapped in `<peer_message from="..." ...>`, with instructions to reply via `peer_send`.

## Security

- Anyone who has the token and can reach the relay can inject prompts into joined sessions. Those sessions act on them with their own tool permissions. Keep the relay on a trusted network and keep the token secret.
- Passing the token through `peer_configure` stores it in that session's chat history. Use the environment variables or write `config.json` yourself if that matters.
- The peer tools skip permission prompts (`skipPermission: true`) so unattended sessions aren't blocked waiting for approval.
- Traffic is plain HTTP. For anything beyond a trusted LAN, put the relay behind TLS (for example a reverse proxy or Tailscale).

## Development

```sh
npm test   # relay, client, and an end-to-end test of extension.mjs with a fake Copilot SDK
```
