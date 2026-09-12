# llm-city-builder

> An LLM plays a 3D SimCity-style city builder. You watch, and you can heckle the mayor.

A fork of [lo-th/3d.city](https://github.com/lo-th/3d.city) (Three.js renderer + [micropolisJS](https://github.com/graememcc/micropolisJS) simulation). The simulation runs headless in Node; an AI agent plays it through a small tool API; browsers connect as viewers and get a chat panel with the mayor's narration, every tool call it makes, a message box, and a running token/cost ledger.

![viewer with chat panel](docs/screenshot.png)

## How it works

```
browser viewers  ──WebSocket──▶  server/           ◀──MCP (http)──  claude -p  (Claude Code CLI)
 (3D render + chat panel)        ├─ sim.js      headless micropolis, single source of truth
                                 ├─ relay.js    snapshot on join, 20 Hz binary diff frames
                                 ├─ gameApi.js  build / build_line / bulldoze / get_map / say / wait …
                                 ├─ mcp.js      the same tools over MCP at /mcp
                                 ├─ agent.js    play loop, system prompt, transcript
                                 └─ ledger.js   tokens + cost
```

- The agent only acts through tools. `say(text)` is its narration channel; everything else is a game action and is echoed to viewers as it happens.
- Viewer messages are delivered to the agent inside its next tool result, so it can answer mid-turn.
- Many viewers are cheap: a late joiner gets one full snapshot (~65 KB), then diffs (~60 B/tick when idle).

## Run it

Requires Node 22+ and one of: the [Claude Code](https://code.claude.com) CLI logged in, an `ANTHROPIC_API_KEY`, or the [Codex](https://github.com/openai/codex) CLI logged in.

```bash
npm install
npm run build                                  # bundle src/ → build/ (rerun after touching src/)

node server/index.js                           # sim + viewers only  → http://localhost:8787/
AGENT=claude-code node server/index.js         # Claude Code CLI plays (your login)
AGENT=claude-code:sonnet node server/index.js  # pick a model alias / id
AGENT=api node server/index.js                 # Anthropic API directly, claude-sonnet-5 (ANTHROPIC_API_KEY in env or .env)
AGENT=api:claude-opus-5 node server/index.js
AGENT=codex node server/index.js               # OpenAI Codex CLI (your ChatGPT login)
```

| env | meaning |
|---|---|
| `PORT` | http/ws port (default 8787) |
| `AGENT` | `claude-code[:model]`, `api[:model]` or `codex[:model]` |
| `MAX_BUDGET_USD` | spend cap for any driver: at the cap the mayor and the clock pause and viewers see why; the owner can raise it. For claude-code it is also passed to the CLI |
| `MAX_CONTEXT_TOKENS` | api only: prompt size that triggers history compaction (default 80000) |
| `THINKING=off` | api only: disable adaptive thinking |
| `EFFORT` | api only: `output_config.effort` (low / medium / high); `low` cuts thinking spend ~5x with no visible drop in play |
| `CODEX_EFFORT` | codex only: `model_reasoning_effort` (low / medium / high) |
| `GAME` | save file, default `saves/latest.json`; restored at boot if it exists, autosaved every `SAVE_EVERY` s (60) and on Ctrl-C |
| `MAP_SIZE` | `WxH` for a new map (default `128x128`) |
| `ADMIN_TOKEN` | owner token; random and printed at start if unset |
| `AGENT_LOG` | file to append the CLI's raw stream-json events to |
| `DEMO=1` | scripted starter town, no agent |

`index.html` is still the original single-player game if you want to play yourself.

## Owner controls and saves

The server prints an owner token at start. Open `/?admin=<token>` once and the chat panel grows a control row: pause/resume (freezes the clock too), save, spend cap, new game with a map size, stop. The token is kept in that browser's localStorage; nobody else can touch the game.

Everything lives in one save file per game (`GAME`, default `saves/latest.json`): the city, the transcript and ledger, unread viewer messages, and the mayor's own conversation (API history, Codex thread, or Claude Code session). Stop the server, start it again, and the mayor carries on mid-thought.

## The tool API

| tool | what it does |
|---|---|
| `get_state` | date, funds, population, RCI demand, taxes, zone counts |
| `get_map` | ASCII map: whole map downsampled, or a full-res window (max 64×64) |
| `get_evaluation` | approval, top problems, service coverage |
| `query x y` | inspect one tile |
| `build tool x y` | zones / buildings, top-left corner; explains what blocks a footprint |
| `build_line tool x0 y0 x1 y1` | road / rail / wire, straight or L-shaped |
| `bulldoze x y w h` | clear a rectangle |
| `set_speed`, `set_budget` | pace and taxes / funding |
| `say text` | talk to the viewers |
| `wait months` | let the sim run, then report |

The definitions live in `server/tools.js` (zod) and are served over MCP; a direct-API driver can reuse them as JSON schema.

## Token tracking

The panel header shows input / output tokens and cost. With Claude Code, per-call usage comes from the stream (`message_start` / `message_delta`); the CLI's authoritative `total_cost_usd` only arrives when the model ends a turn, so until then the cost is estimated from a price table and shown as `~$x`. The API driver prices each call from the same table. Codex reports tokens but no price (it runs on your ChatGPT plan), so the panel shows `cost n/a`.

The API driver keeps one long conversation: tool results older than two turns collapse to a line, and once the prompt passes `MAX_CONTEXT_TOKENS` the model writes itself a "state of the city" note that replaces the older history.

## Status / roadmap

- [x] Headless sim, relay, viewer mode
- [x] Tool API, MCP server, Claude Code driver, chat panel, ledger
- [x] Direct Anthropic API driver, Codex driver
- [x] Persistence, owner pause/resume, spend caps, map sizes, viewer-only HUD

See [docs/PLAN.md](docs/PLAN.md) for details and gotchas.

## License

The renderer and this fork's server code follow upstream 3d.city (MIT, see [LICENSE](LICENSE)). The simulation engine in `src/micro` is derived from micropolisJS, which is GPL‑3 — treat the combined work as GPL‑3.
