# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The design surfaces are a planned browser dashboard (web) and two terminal panes that already exist: the Claude Code `/bridge` roster pane (`packages/bridge-harness-claude-mod/hooks/register.tsx`) and the Pi `/bridge` overlay (`packages/bridge-harness-pi/src/bridge-panel.ts`). Terminal panes are text UIs with no CSS, so web guidance applies to them only where it fits a terminal.

## Stack

- Repo: TypeScript, ES modules, Node >= 18. The MCP server, CLI and shared code build to `dist/`; the Pi extension ships `src/` as is.
- Web dashboard: delegated. The user left the choice to Claude when the dashboard is built. Default to the repo's TypeScript and pick the lightest option that can show live NATS state.

## Users

- Primary: a developer who runs several coding agents (Claude Code, Pi, omp) in separate terminals, git worktrees or machines, and wants the agents to talk to each other directly instead of copying messages between them.
- Secondary: teams whose agents meet on a shared LAN or remote NATS server. The product is built for solo use first.

## Product Purpose

bridge-harness gives coding agents from different vendors a live messaging channel over NATS. Agents send, receive and react on their own: Claude Code sends and Pi wakes through `triggerTurn`; Pi replies and Claude Code wakes through the asyncRewake hook. Success means the human starts a thread and stops being the messenger.

## Positioning

- Cross-vendor: agents running different models (Claude, plus whatever Pi or omp runs, such as Gemini, Kimi, GPT or DeepSeek) work on the same thread. Sub-agents are always copies of the parent model.
- Reactive both ways in real time over NATS pub/sub, without polling, scratch files or relay scripts.
- Agents stay alive as peers that can talk back and forth, unlike one-shot sub-agents. Each spawned agent runs in its own visible terminal tab.

## Operating Context

- Agents run inside terminal coding tools: Claude Code (MCP server plus the rewake hook), Pi (extension) and omp.
- `project` is the NATS namespace, taken from the git worktree root or `BRIDGE_PROJECT`. Subjects, registry, presence and the default lobby room are all keyed on it. Each agent joins the room named after its project automatically, and `use_bridge` switches namespace at runtime.
- Agent tools: `whoami`, `list_agents`, `who_is_in`, `join_room`, `send`, `read`, `set_name`, `set_status`, `spawn_agent`, `use_bridge`. An agent can DM `agent:<id>` across projects and worktrees.
- NATS can run locally, on a LAN or in the cloud.
- Running processes keep their code in memory, so changes reach only newly started sessions.

## Capabilities and Constraints

- Presence is live, and agents that join late still see who is already online.
- The roster pane marks an agent stale after 60s without a heartbeat and drops it after 5 minutes.
- The Claude Code mod module cannot open sockets, so a bundled Node helper (`helper/bridge-tap.mjs`) streams presence, registry and DM events to it as JSON lines.
- `package.json` and `packages/bridge-harness-pi/package.json` are released in lockstep and their versions must match.
- Open decision: what the web dashboard shows (roster only, or message threads too) and how it reaches NATS.

## Brand Commitments

Current preferences. The user selected these but also marked nothing as binding yet, so treat them as the default to keep, not a lock:

- Each agent kind keeps its own color everywhere: Claude Code blue, Pi purple.
- The README voice is playful and uses lots of emoji, with short taglines such as "no files · no copy-paste · no polling".
- The Claude Code pane and the Pi overlay show the same roster information in the same way.

## Evidence on Hand

- `README.md` has a sample Claude ↔ Pi conversation drawn in ASCII, a list of features and a comparison with sub-agents.
- Badges cover npm, NATS and the MIT license.
- There are no real testimonials, user counts, benchmarks or case studies. Do not invent any. The "sub-millisecond" claim in the README describes NATS itself, not a measured benchmark of this product.

## Product Principles

1. Keep the human out of the relay: every surface should cut the copy-and-paste work between agents, never add a step.
2. Make identity obvious: who an agent is, which vendor or kind it is, which project it belongs to and whether it is live should read at a glance on every surface.
3. Keep the surfaces consistent: the Claude pane, the Pi overlay and the dashboard show one roster model in one vocabulary.
4. Show live state as it is: show presence, staleness and delivery honestly, and never imply an agent is reachable when it isn't.
5. Stay vendor-neutral: no vendor's agent is presented as the main one.
