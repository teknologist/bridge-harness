---
name: bridge-e2e-test
description: Repeatable end-to-end test of bridge-harness. Spawns two agents on two different hosts through the dashboard; they must reach each other and the agent running the test. Use when the user asks to "test end to end", "run the e2e test", or verify spawning and cross-host messaging.
---

# Bridge end-to-end test

**Pass means:** two agents, spawned through the dashboard on two **different hosts**,
exchange a ping and a pong over the bridge, and each one reports to you (the agent running
the test).

```figure
  {accent:you (owner)}  ◄──── online / PASS ────  {strong:e2e-a}  this machine
        ▲                                │ ping ▲ pong
        │                                ▼      │
        └──────── online / PASS ──────── {strong:e2e-b}  remote Rex host
```

## Preconditions

- The dashboard runs on `http://127.0.0.1:4317`. There is only one instance; never start a second.
- `BRIDGE_DASHBOARD_TOKEN` is set. If it isn't, ask the user for it.
- The remote host (default `Glod (eric)`) appears in `curl -H "Authorization: Bearer $BRIDGE_DASHBOARD_TOKEN" http://127.0.0.1:4317/api/hosts`.

## Run

1. Get your own id with `whoami` (bridge tool). This is OWNER.
2. Spawn the pair:
   ```bash
   sh .claude/skills/bridge-e2e-test/spawn-pair.sh <OWNER> ["<remote host>"]
   ```
   Both lines must say `"spawned":true`. Note the printed `run=` id.
   On a host where the home folder was never trusted, the remote tab stops at Claude's
   "trust this folder" prompt. Answer it: find the block (see Cleanup), then
   `rex -S "<host>" send -b <block> $'\e[B'` and `rex -S "<host>" send -b <block> $'\r'`.
3. Wait for bridge DMs and read them with `read`. Allow about 6 minutes, because the agents
   wait for each other. You should receive:
   - `e2e-a-<run> online on <host1>` and `e2e-b-<run> online on <host2>`, with host1 ≠ host2
   - `e2e-a-<run> PASS: ping answered by e2e-b-<run>`
   - `e2e-b-<run> PASS: ping answered by e2e-a-<run>`

   Each agent pings its peer and answers any ping with a pong, so each PASS proves a round
   trip in both directions across the two hosts.
4. **PASS** only if all four arrived and the two hostnames differ. Report any `FAIL:` message,
   or anything missing, as a failure.
5. Optional UI check, using the Brave Agent profile only (`bsk --browser "Agent Profile"`):
   open the dashboard, then THREADS. Both agents' threads should show their DMs to the dashboard.

## Cleanup

Close both tabs:

- **Local tab:** find its block with `rex window list --json` (label `e2e-a-<run>`), then run
  `rex block close <block>`.
- **Remote tab:** it is in session `bridge-agents` on the remote host. Use the same commands with
  `rex -S "<remote host>"`.

## Known failure modes

- **Spawn returns a manual command instead of `spawned:true`:** the dashboard has no Rex pane
  controller. Check that `rex` is on its PATH.
- **Remote tab shows `command not found: claude`:** the agent CLI is on PATH only through
  `~/.zshrc`. Remote spawns pass `--interactive` for this, but only after the dashboard has been
  restarted on a fresh root `npm run build`. Its watch mode does not reload root `dist/`.
- **The remote agent never comes online:** `claude` or the bridge MCP is missing on that host, or
  the host is offline. Look at its tab with `rex -S "<host>" capture -b <block>`.
- **An agent can't find its peer:** both agents must be on the same NATS server. The dashboard's
  `/api/state` `status.natsUrl` shows which one it uses.
