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
- **M3** API driver (Anthropic SDK), Codex driver.
- **M4** persistence (save/restore city + transcript), agent pause/resume,
  spend caps, multi map sizes.

## Running

```
npm run build                       # bundle (needed after touching src/)
node server/index.js                # sim + viewer only, http://localhost:8787/
AGENT=claude-code node server/index.js          # Claude Code plays (default model)
AGENT=claude-code:sonnet MAX_BUDGET_USD=2 ...    # pick model, cap spend
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
