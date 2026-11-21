---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: []
---

# Bridge dashboard (web UI)

Mode: Operate. Audience: a solo dev (teams second) running many Claude Code, Pi and omp agents across terminals, worktrees and machines. They watch from a second screen or a phone over LAN or Tailscale. Job: see who is live, read and answer threads, act (send, rename, status, spawn), and review fleet history. Constraints: same liveness model as the TUI (stale at 60s, dropped at 5min); per-agent colors Claude blue and Pi purple; token auth; must work at phone width.

## Direction contract

THESIS: The fleet is a departures board. Each agent is a row whose cells flip when its state changes, so a glance tells you what moved. It refuses the grey admin table with status pills.

OWN-WORLD: Matte housing (#121417) with flap tiles (#1f2328) split by a hairline (#0a0b0d) and off-white flap text (#ecebe4). The kind mark is a square lamp: Claude #4f8cf0, Pi #9b74ec, human amber. Amber #f2b632 is reserved for action and new mail. Live is green #7fd18b; stale dims the row and its status flap reads STALE. Barlow Semi Condensed handles labels, uppercase and tracked, and Martian Mono sets every flap: ids, times, counts.

STORY: The visitor sees in one look how many agents are live and where, notices a row that just flipped, opens a thread, replies, and leaves.

FIRST VIEWPORT: The top bar carries the brand, the project tabs (All plus each project), Threads and History, and the NATS lamp on the right. The board fills the left two thirds as rows of agent, project, host, task, seen, status and mail. The thread drawer on the right has a header, the messages, and the send bar as the primary action. On a phone the board is a single column of rows, and the drawer becomes a full-screen sheet.

FORM: Split-flap departure board, position 1 on my ordered list (IMPECCABLE'S PICK, chosen over the assigned key rack). seed:a33eb4c6ddc88451. Signature move: a changed cell flips character by character. It flips once and the changed flap keeps an amber full outline until the row is seen; reduced motion swaps the flip for a crossfade.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Open decisions
- Whether History is a timeline or a board of past events (default: a board of past events with a day filter).
