# llm-city-builder — plan

Fork of [lo-th/3d.city](https://github.com/lo-th/3d.city). An LLM plays the city;
people watch in the browser and can talk to it.

## Architecture

```
 browsers (viewers)            server/ (Node 22)                       agent
 ┌──────────────┐   WS    ┌──────────────────────────┐   MCP/HTTP   ┌────────────┐
 │ 3d.city view │◄───────►│ sim.js  headless micro sim│◄───────────►│ claude -p  │
 │ + chat panel │         │ relay.js WS broadcast     │             │ codex exec │
 └──────────────┘         │ gameApi.js tool surface   │◄──SDK loop──│ api driver │
                          │ mcp.js   MCP server       │             └────────────┘
                          │ ledger.js token/cost      │
                          └──────────────────────────┘
```

- The micropolis sim (`src/micro`) runs headless in Node. It is the single
  source of truth. Browsers are viewers: `WorkerBridge` gains a `remote`
  transport that receives the exact same `{tell:...}` messages over WebSocket
  that the Web Worker used to post, so `dispatch()` is untouched.
- Viewers may send read-only tells (BUDGET, EVAL, HISTORY, GETOVERLAY…).
  Mutating tells (TOOL, MAPCLICK, SPEED, NEWBUDGET…) only come from the agent.
- One tool surface (`gameApi.js`) drives the sim via the same TOOL/MAPCLICK
  messages the mouse used. Drivers differ only in who calls it:
  - `drivers/claudeCode.js` — spawns `claude -p --output-format stream-json`
    with an MCP config pointing at our MCP server. Usage from `result` events.
  - `drivers/codex.js` — `codex exec --json`, same MCP server.
  - `drivers/api.js` — Anthropic SDK tool loop, usage from `response.usage`.
- `say(text)` is a tool; that is the narration channel. Tool calls are also
  echoed to the transcript ("road 40,52 → 40,70"). User chat goes into
  `GameApi.inbox` and rides along inside the next tool result
  (`viewerMessages`), so the agent sees it mid-turn; anything left over is
  prepended to the next nudge.
- Ledger: per-turn and cumulative input / output / cache-read / cache-write
  tokens and estimated USD, broadcast to viewers.

## Milestones

- **M1** ✅ headless sim + WS relay + browser viewer mode (snapshot on join,
  throttled/diffed RUN broadcast).
- **M2** ✅ gameApi + MCP server + Claude Code driver + chat panel + ledger.
- **M3** ✅ API driver (Anthropic SDK), Codex driver. Tasks:
  - **M3.1** `server/drivers/anthropicApi.js` — manual streaming tool loop
    on `@anthropic-ai/sdk`. Tools come from `tools.js` (`toJsonSchema`) and
    are executed in-process against `GameApi` (no MCP hop). Adaptive
    thinking, `cache_control` on system + tools, per-call usage → ledger.
    Key from `ANTHROPIC_API_KEY`; default model `claude-sonnet-5`.
    Cost is computed from the price table and reported as authoritative
    (there is no `total_cost_usd` equivalent from the API).
  - **M3.2** Context management for M3.1: sliding window at turn
    boundaries, tool results older than 2 turns truncated to one line,
    and when the last call's input exceeds `MAX_CONTEXT_TOKENS`
    (default 80k) the model writes a short "state of the city" note that
    replaces the dropped history.
  - **M3.3** `server/drivers/codex.js` — `codex exec --json` per turn,
    `codex exec resume <thread>` for continuation, MCP via
    `-c mcp_servers.city.url=`, system prompt via AGENTS.md in a private
    cwd. Parse `thread.started`, `item.completed`, `turn.completed.usage`.
  - **M3.4** Wiring: `AGENT=api[:model]`, `AGENT=codex[:model]` in
    `index.js`; OpenAI rows in the ledger price table; README + Running.
  - **M3.5** Smoke-test each driver for a few turns against the viewer.
    Codex verified (Sep 12 2026: founds a city, resumes across turns,
    tokens land in the ledger). API driver verified against a scripted
    fake client only — needs a real-key run.
- **M4** persistence (save/restore city + transcript), agent pause/resume,
  spend caps, multi map sizes.

## Running

```
npm run build                       # bundle (needed after touching src/)
node server/index.js                # sim + viewer only, http://localhost:8787/
AGENT=claude-code node server/index.js          # Claude Code plays (default model)
AGENT=claude-code:sonnet MAX_BUDGET_USD=2 ...    # pick model, cap spend
ANTHROPIC_API_KEY=... AGENT=api node server/index.js        # direct API, claude-sonnet-5
AGENT=api:claude-opus-5 MAX_CONTEXT_TOKENS=120000 THINKING=off ...
AGENT=codex node server/index.js                 # Codex CLI (ChatGPT login), default model
AGENT=codex:gpt-5.5 CODEX_EFFORT=low ...
AGENT_LOG=agent.jsonl ...                       # raw stream-json from the CLI
DEMO=1 ...                                      # scripted starter town, no agent
```

## Notes

- Claude Code driver: one long-lived `claude -p --input-format stream-json
  --output-format stream-json --include-partial-messages --tools "" --restricted
  --strict-mcp-config --mcp-config {city: http://localhost:PORT/mcp}
  --allowedTools mcp__city__*`. Token usage comes from `stream_event`
  `message_start` / `message_delta` (the per-block `assistant` events repeat a
  placeholder usage); `result.total_cost_usd` is session-cumulative and only
  arrives when the model ends its turn, so the ledger estimates from a price
  table until then (`estimated: true`).
- The CLI child must die with the server (`process.on('exit')` SIGKILL);
  an orphaned mayor keeps playing against whatever is listening on the port.
- `sim.tilesData` is the render layer (tile values only). Flags (ZONEBIT,
  POWERBIT) live in `map.data[i].getRawValue()`.
- Building tools run with auto-bulldoze on (trees/rubble, +$1/tile); water
  and structures still block, and `build` explains what's in the way.

- `package.json` says MIT; `LICENSE` is micropolisJS GPL‑3. The sim is GPL.
- Sim tick: `MainGame.tick()` re-arms with `setTimeout(0)`; `simFrame()` gates
  on a per-speed threshold. RUN posts carry the full `Uint16Array` tile map
  (32 KB at 128×128) ~30×/s — must be throttled + diffed for the wire.
- Codex: `codex exec resume` rejects `--sandbox`/`-C`, so sandbox goes via
  `-c sandbox_mode` and cwd via spawn. MCP tools need
  `mcp_servers.city.default_tools_approval_mode="approve"` or every call
  fails with "requires approval". Instructions come from AGENTS.md in
  `server/.codex-mayor/` (gitignored). Each turn re-sends Codex's own
  ~40k system prompt, nearly all cache hits. No price table for its
  models; ledger reports `priced:false` and the panel shows "cost n/a".
- API driver: history is a list of turns; tool results older than two
  turns collapse to one line, and when the last prompt exceeded
  `MAX_CONTEXT_TOKENS` everything but the last six turns is replaced by a
  model-written summary (`tool_choice: none`). Cost is price-table but
  reported as authoritative since the API gives nothing better.
