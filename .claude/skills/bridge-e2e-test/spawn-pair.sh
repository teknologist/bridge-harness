#!/bin/sh
# Spawn the two agents of the bridge end-to-end test through the local dashboard.
# Usage: spawn-pair.sh <owner-agentId> [remote-host] [run-id]
# Env: BRIDGE_DASHBOARD_TOKEN (required), BRIDGE_DASHBOARD_URL (default http://127.0.0.1:4317)
set -eu
OWNER=${1:?owner agentId (from whoami)}
REMOTE=${2:-Glod (eric)}
RUN=${3:-$(date +%H%M%S)}
URL=${BRIDGE_DASHBOARD_URL:-http://127.0.0.1:4317}
TOKEN=${BRIDGE_DASHBOARD_TOKEN:?set BRIDGE_DASHBOARD_TOKEN}
A="e2e-a-$RUN"
B="e2e-b-$RUN"

# The task must stay on one line with no '#': the spawn API rejects both.
task() { # $1 = me, $2 = peer
  printf '%s' "End-to-end bridge test, run $RUN. You are $1, your peer is agent:$2 on another host, the test owner is agent:$OWNER. Step 1: DM agent:$OWNER the text \"$1 online on <your hostname>\" (run hostname). Rule for the whole test: whenever you receive \"ping from $2\", DM agent:$2 \"pong from $1\" at once. Step 2: call list_agents until a peer named $2 shows up, then DM agent:$2 \"ping from $1\". The peer may take a few minutes to start. Measure time with the shell command date +%s, never by guessing, and wait about 15 seconds between checks. Step 3: when \"pong from $2\" arrives (its answer to your ping), DM agent:$OWNER \"$1 PASS: ping answered by $2\". Give up only after 6 minutes by date +%s since you came online, then DM agent:$OWNER \"$1 FAIL: <what was missing>\". Keep answering pings until then. Then stop."
}

spawn() { # $1 = name, $2 = host ('' = this machine), $3 = task
  python3 -c 'import json,sys; print(json.dumps({"tool":"claude","name":sys.argv[1],"host":sys.argv[2],"task":sys.argv[3],"model":"claude-haiku-5-5"}))' "$1" "$2" "$3" |
    curl -sS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST "$URL/api/spawn" --data-binary @-
  echo
}

spawn "$A" "" "$(task "$A" "$B")"
spawn "$B" "$REMOTE" "$(task "$B" "$A")"
echo "run=$RUN a=$A (this machine) b=$B ($REMOTE)"
