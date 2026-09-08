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
  echoed to the transcript ("road 40,52 → 40,70"). User chat is queued and
  delivered to the agent on its next turn.
- Ledger: per-turn and cumulative input / output / cache-read / cache-write
  tokens and estimated USD, broadcast to viewers.

## Milestones

- **M1** headless sim + WS relay + browser viewer mode (snapshot on join,
  throttled/diffed RUN broadcast).
- **M2** gameApi + MCP server + Claude Code driver + chat panel + ledger.
- **M3** API driver (Anthropic SDK), Codex driver.
- **M4** persistence (save/restore city + transcript), agent pause/resume,
  spend caps, multi map sizes.

## Notes

- `package.json` says MIT; `LICENSE` is micropolisJS GPL‑3. The sim is GPL.
- Sim tick: `MainGame.tick()` re-arms with `setTimeout(0)`; `simFrame()` gates
  on a per-speed threshold. RUN posts carry the full `Uint16Array` tile map
  (32 KB at 128×128) ~30×/s — must be throttled + diffed for the wire.
