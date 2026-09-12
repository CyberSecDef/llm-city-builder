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
    Both verified Sep 12 2026. Codex founds a city, resumes across turns,
    tokens land in the ledger. API driver (Sonnet 5): input_tokens=2 per
    call with everything else a cache hit; adaptive thinking spiked to
    7k output tokens on planning calls (~$6/h), `EFFORT=low` keeps it
    under 1.5k with the same behaviour.
- **M4** ✅ persistence, owner controls, spend caps, map sizes, viewer HUD.
  Decisions (Sep 12 2026): one save file per game that captures everything
  needed to continue as if the server never stopped; the spend cap pauses
  the sim as well as the agent and viewers see it; only the owner can
  pause/resume/stop, via an admin token printed to stdout at start. Tasks:
  - **M4.1** `server/save.js` — `GAME=path.json` (default `saves/latest.json`).
    Contents: micropolis save JSON (`SAVEGAME` round-trip through the
    headless sim, `MAKELOADGAME` to restore), agent transcript + ledger +
    inbox, and driver state via `driver.serialize()/restore()`: API driver
    = its `turns` + `lastInput`; Codex = thread id (`exec resume`);
    Claude Code = session id (`--resume`). Autosave every 60 s and on
    shutdown; load at boot if the file exists.
  - **M4.2** Admin token (`ADMIN_TOKEN` env or random, printed at start).
    WS `ADMIN {token, action}` with pause / resume / stop / save /
    new_game; pause freezes agent and sim (speed 0), resume restores.
    `?admin=<token>` on watch.html stores it and shows the controls.
    Host broadcasts `AGENT_STATE {running, paused, reason, cap}`.
  - **M4.3** Spend cap for every driver: `MAX_BUDGET_USD` checked against
    the ledger after each step; on hit → pause with reason `budget`,
    panel shows `$x / $cap · spend cap reached`. Owner can raise it
    (`set_cap`). Unpriced models (Codex) can't be capped; say so.
  - **M4.4** `MAP_SIZE=WxH` env and `new_game {mapSize}` admin action.
  - **M4.5** Viewer HUD: no build bar, speed buttons, disaster or files
    panels in remote mode; info panels stay.

## Running

```
npm run build                       # bundle (needed after touching src/)
node server/index.js                # sim + viewer only, http://localhost:8787/
AGENT=claude-code node server/index.js          # Claude Code plays (default model)
AGENT=claude-code:sonnet MAX_BUDGET_USD=2 ...    # pick model, cap spend
ANTHROPIC_API_KEY=... AGENT=api node server/index.js        # direct API, claude-sonnet-5
AGENT=api:claude-opus-5 EFFORT=low MAX_CONTEXT_TOKENS=120000 THINKING=off ...
# .env is loaded by the npm scripts (node --env-file-if-exists=.env); it is gitignored
AGENT=codex node server/index.js                 # Codex CLI (ChatGPT login), default model
AGENT=codex:gpt-5.5 CODEX_EFFORT=low ...
AGENT_LOG=agent.jsonl ...                       # raw stream-json from the CLI
DEMO=1 ...                                      # scripted starter town, no agent
GAME=saves/weberton.json ...                    # save file (default saves/latest.json); restored at boot if present
MAP_SIZE=64x64 SAVE_EVERY=30 ADMIN_TOKEN=secret ... # new-map size, autosave period (s), fixed owner token
MAX_BUDGET_USD=2 ...                            # any driver: pauses mayor + clock at $2, owner can raise it
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
- Persistence: `server/save.js` writes `{version, savedAt, agentSpec, city,
  agent}` atomically; `city` is the micropolis SAVEGAME blob obtained by
  posting SAVEGAME to the headless sim (`Sim.save()`), restored with
  MAKELOADGAME (`Sim.load()`). `agent` is `AgentHost.serialize()`:
  transcript, ledger, inbox, pause state, cap, and `driver.serialize()`
  (API: full `turns`; Codex: thread id; Claude Code: session id → `--resume`,
  verified to keep context). A mid-turn save can end on an assistant
  message with unanswered tool calls; `AnthropicApiDriver.restore` drops it.
- Owner controls: `ADMIN {token, action}` over the same WebSocket; token
  printed at start (or `ADMIN_TOKEN`). Actions pause / resume / stop / save /
  set_cap / new_game. Pause sets sim speed 0 and asks the driver to end its
  turn after the current model call (`interrupt()`, API driver only; the
  CLI drivers finish their turn). A `wait` tool call in flight blocks until
  resume, which is the intended effect.
- Viewer rendering: the 3D build lists (`buildingLists`/`townLists`) only
  ever came from the local player's clicks, so viewers saw terrain and
  roads but no buildings. `View.rebuildFromTiles()` now derives them from
  zone-centre tile values on every FULLREBUILD without cityData, and the
  relay tags BUILD messages with the sim's selected tool so
  `View.remoteBuild()` replays each placement (and bulldoze) live.
  Headless Chromium (swiftshader) fails `copyTextureToTexture` for tile
  textures, so roads can't be checked in screenshots; verify in a real browser.
- Build rules (Sep 12 2026): every build() footprint must border a road
  tile (ring check, bridges count); build() prepares the site first — shore
  water is filled outward from land at $25/tile (`LANDFILL_COST`, a direct
  `map.setTile(DIRT)` plus `budget.spend`), then every non-dirt tile is
  bulldozed with the real bulldozer tool so viewers get the BUILD replay and
  the mayor pays $1/tile. build_line fills shore water and clears trees per
  tile but leaves wires/rails for the road tool to cross. Open water with no
  land beside it is refused.
- Road network (Sep 12 2026): after the first road, a road tile is only
  placed if it 4-touches an existing road (`_roadNeighbours`), lines grow
  outward so each tile sees the one before it; build() refuses footprints
  containing road; bulldoze skips road tiles whose removal would disconnect
  their neighbours (`_wouldSplitRoads`, flood fill over road tiles).
- Starter road (Sep 12 2026): `GameApi.starterRoad()` after every NEWMAP —
  picks the border with the least water in a 5-wide band two tiles in,
  fills that band, lays the road for free (funds restored), records
  `api.starter` for the kickoff prompt. Owner token can also be entered via
  the 🔑 button in the panel header (prompt → localStorage).
- Terrain (Sep 12 2026): classic generator gave 30–50% water. `Micro.TERRAIN_STYLE
  = 'lakes'` (set per NEWMAP from the server's `terrain` option) skips rivers
  and islands and grows `TERRAIN_LAKES` lakes by plopping river blobs until
  `TERRAIN_WATER_FRACTION` of tiles are water (measured 10.0–10.2%).
- Viewer terrain: heights are derived from tiles only in paintMap, so land
  the server makes from water stayed under the sea plane ("roads under
  water"). Fixes: GameApi emits `landfill` → relay `LANDFILL` → `View.liftTiles`
  (makePlanar to 0.25); `liftBuiltShore()` on snapshots; and `newGame()`
  mutes the relay until the starter road is laid, then `relay.resync()`
  sends every viewer a fresh snapshot.
- Viewer self-heal (Sep 12 2026): `View.reconcile()` every 5 s in remote
  mode — drawLayer scan for missed ground tiles, zone/building lists
  reconciled against zone-centre tile values (missing added, stale removed,
  changed levels updated), tree meshes dropped where the tile is no longer a
  tree. Base.C had 475 where CZB+36 = 472, leaving one commercial level
  invisible everywhere; fixed. Park fountains (840) are now reconstructed.
