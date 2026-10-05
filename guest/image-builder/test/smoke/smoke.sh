#!/usr/bin/env bash
# The engine smoke: the guest's two users and two daemons in one Linux container,
# laid out the way the runtime disk's install.sh lays out a Dot's VM, with a
# fake host talking to dot-agentd's TCP port and a stand-in for OpenRouter.
# prepare-engine.sh has built the golden venv (build-engine-env.sh) and the
# runtime disk's engine source, and run.sh built dot-agentd; this script runs
# the Dot, as root, in the container run.sh makes.
#   $AGENTD_BIN     dot-agentd for linux/amd64 (copied to /opt/invisible-dots/bin)
#   /opt/invisible-dots-engine/bin/python   the engine's venv; its source is /opt/invisible-dots/engine
#   fake_openrouter.py, host-stream.sh      next to this script
# Exits non-zero when a check failed or was skipped, and always prints
#   SMOKE: <passed> passed, <failed> failed, <skipped> skipped
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
set -uo pipefail
PASS=0; FAIL=0
ok() { echo "PASS: $*"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $*"; FAIL=$((FAIL+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# The checks that pin a removal from the model's text: each runs only when its
# name is in PIN_REMOVALS, otherwise it is reported as skipped. The engine has
# nothing of them from the start, so both run at every gate:
#   prompt-text   the system prompt and the exec tool's description name no
#                 approval or elevation mechanism (/approve, approval-pending,
#                 Guardian, elevated)
#   exec-schema   the exec tool's parameter schema has no "elevated" property
PIN_REMOVALS="${PIN_REMOVALS-prompt-text exec-schema}"
SKIP=0
pinned() { case " $PIN_REMOVALS " in *" $1 "*) return 0;; esac; return 1; }
check_pinned() { # name, label, command
  if pinned "$1"; then check "$2" "$3"; else echo "SKIP: $2 (pin '$1' is not in PIN_REMOVALS yet)"; SKIP=$((SKIP+1)); fi
}

# >>> request checks
# The stand-in for OpenRouter appends every request it receives, whole, to FULL.
FULL="${FULL:-/tmp/fake-full.jsonl}"
# sys: a request's system prompt, the text of its system and developer
# messages, whether the content is a string or a list of parts.
# exec_tool: the exec tool as offered ({name, description, parameters}), or null.
REQ_DEFS='def sys: [.messages[]? | select(.role == "system" or .role == "developer") | .content
    | if type == "string" then . elif type == "array" then (map(.text? // "") | join("")) else "" end] | join("\n");
  def exec_tool: [.tools[]? | (.function // .) | select(.name == "exec")][0];
  def banned: "/approve|approval-pending|Guardian|elevated";
  def model_text: sys + "\n" + (exec_tool.description // "");
  def exec_requests: [.[] | select(exec_tool != null)];'
req_jq() { jq -s -e "$REQ_DEFS $1" "$FULL" >/dev/null 2>&1; }
# (a) A request carried a system prompt and the exec tool with its command parameter.
req_prompt_and_exec() { req_jq 'any(.[]; (sys | length) > 0 and exec_tool.parameters.properties.command != null)'; }
# (b) No request's system prompt or exec description names a banned string.
#     At least one request must offer exec, so an empty log cannot pass.
req_no_approval_text() { req_jq '(exec_requests | length) > 0 and all(.[]; model_text | test(banned; "i") | not)'; }
# (c) No exec schema has an "elevated" key, at any depth.
req_exec_schema_clean() { req_jq '(exec_requests | length) > 0 and all(exec_requests[]; [exec_tool.parameters | .. | objects | has("elevated")] | any | not)'; }
# What the banned strings are next to, for the log (shown whether or not the check runs).
req_banned_seen() {
  jq -s -r "$REQ_DEFS"' [.[] | model_text | match("[^\n]{0,50}(" + banned + ")[^\n]{0,50}"; "gi") | .string] | unique | .[:12][]' "$FULL" 2>/dev/null
}
# <<< request checks

ENGINE_PY=/opt/invisible-dots-engine/bin/python

# --- the golden image's users (builder/user-data.yaml) and the runtime disk ---
useradd -m -s /bin/bash dot
useradd -m -s /usr/sbin/nologin -G dot dotengine
chmod 0750 /home/dot
mkdir -p /opt/invisible-dots/bin /etc/invisible-dots /run
cp "$AGENTD_BIN" /opt/invisible-dots/bin/dot-agentd; chmod 0755 /opt/invisible-dots/bin/dot-agentd
# install.sh's directory and socket steps (the systemd parts do not run here).
install -d -o dot -g dotengine -m 2750 /run/invisible-dots
install -d -o dotengine -g dot -m 2750 /run/invisible-dots-agent
install -d -o dot -g dot -m 2775 /home/dot/workspace
install -d -o dotengine -g dotengine -m 0700 /home/dotengine /home/dotengine/state
# The engine needs no privilege: no sudoers rule, no config directory.
check "the engine has no sudo rule (no /etc/sudoers.d/invisible-dots-engine, no sudo for dotengine)" "[ ! -e /etc/sudoers.d/invisible-dots-engine ] && ! su -s /bin/bash dotengine -c 'sudo -n true' >/dev/null 2>&1"
check "no sudoers file names dotengine (the old engine's rule is gone with the config installer)" "! grep -rqs dotengine /etc/sudoers /etc/sudoers.d"
check "dotengine is in no group but its own and dot" "[ \"\$(id -nG dotengine | tr ' ' '\n' | sort | tr '\n' ' ')\" = 'dot dotengine ' ]"
TOKEN="smoke-token-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '{"dotId":"dot_smoke","token":"%s"}' "$TOKEN" > /etc/invisible-dots/config.json
chown dot:dot /etc/invisible-dots/config.json; chmod 0600 /etc/invisible-dots/config.json
check "the engine cannot read the host's token (/etc/invisible-dots/config.json is dot's, 0600)" "[ \"\$(stat -c '%U:%G %a' /etc/invisible-dots/config.json)\" = 'dot:dot 600' ] && ! su -s /bin/bash dotengine -c 'cat /etc/invisible-dots/config.json' >/dev/null 2>&1"

# --- the stand-in for OpenRouter ---
# The key has this one owner; the stand-in gets it on its command line (not its environment: a check
# below asserts that no process environment holds it) and refuses to start without it.
KEY=sk-or-v1-smoke-0123456789abcdef
# (Copied out of the tree under test, where the unprivileged user may not reach it, and out of
# the directories the key sweeps below read: the stand-in holds the key in its memory.)
install -D -m 0644 "$HERE/fake_openrouter.py" /usr/local/lib/smoke-fake/fake_openrouter.py
su -s /bin/bash nobody -c "python3 /usr/local/lib/smoke-fake/fake_openrouter.py 9999 $KEY" > /tmp/fake.log 2>&1 &
# --- dot-agentd as dot ---
su -s /bin/bash dot -c "HOME=/home/dot /opt/invisible-dots/bin/dot-agentd --listen 127.0.0.1:1024" > /tmp/agentd.log 2>&1 &
# --- the engine as dotengine, restarted when it dies, as systemd would (KillMode=control-group:
#     every process of the engine goes with it). The unit's environment, plus the stand-in. ---
cat > /tmp/engine.sh <<'EOF'
export HOME=/home/dotengine
export PATH=/home/dot/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export TIKTOKEN_CACHE_DIR=/opt/invisible-dots-engine/share/tiktoken
export INVISIBLE_DOTS_ENGINE_STATE=/home/dotengine/state
export INVISIBLE_DOTS_AGENT_SOCKET=/run/invisible-dots-agent/agent.sock INVISIBLE_DOTS_AGENTD_SOCKET=/run/invisible-dots/agentd.sock
export INVISIBLE_DOTS_AGENTD_BIN=/opt/invisible-dots/bin/dot-agentd INVISIBLE_DOTS_WORKSPACE=/home/dot/workspace
export INVISIBLE_DOTS_OPENROUTER_URL=http://127.0.0.1:9999/api/v1 INVISIBLE_DOTS_NETWORK_CHECK=127.0.0.1:9999
umask 0002
cd /home/dotengine
exec /opt/invisible-dots-engine/bin/python -I -B -m nanobot
EOF
chmod 0755 /tmp/engine.sh
start_engine() { su -s /bin/bash dotengine -c "bash /tmp/engine.sh" >> /tmp/engine.log 2>&1 & }
start_engine

H=(-sS -H "Authorization: Bearer $TOKEN")
api() { curl "${H[@]}" "$@"; }
A=http://127.0.0.1:1024/v1/agent
wait_health() {
  for _ in $(seq 1 180); do
    if api "$A/health" 2>/dev/null | grep -q '"status":"ok"'; then return 0; fi
    sleep 1
  done
  return 1
}
check "the engine answers /health through dot-agentd" "wait_health"
echo "health: $(api http://127.0.0.1:1024/v1/health)"
check "the engine runs as dotengine" "pgrep -u dotengine -f 'python.*-m nanobot' >/dev/null && ! pgrep -u root -f 'python.*-m nanobot' >/dev/null"
ENGINE_UID=$(id -u dotengine)
tcp_listeners_of_engine() { awk -v u="$ENGINE_UID" 'FNR>1 && $4=="0A" && $8==u' /proc/net/tcp /proc/net/tcp6; }
check "the engine listens on no TCP port" "[ -z \"\$(tcp_listeners_of_engine)\" ]"
check "agent.sock is in the engine's directory, group dot, 0660" "[ \"\$(stat -c '%U:%G %a' /run/invisible-dots-agent/agent.sock)\" = 'dotengine:dot 660' ]"
check "agentd.sock is dot's, group dotengine, 0660" "[ \"\$(stat -c '%U:%G %a' /run/invisible-dots/agentd.sock)\" = 'dot:dotengine 660' ]"
check "dot cannot write the engine's socket directory" "! su -s /bin/bash dot -c 'touch /run/invisible-dots-agent/x' 2>/dev/null"

# The decision for every permission, as the host's toRuntimeConfig sends it; changed below.
echo '{"computer.exec":"allow"}' > /tmp/perms.json; chmod 0644 /tmp/perms.json
echo true > /tmp/memory.json; chmod 0644 /tmp/memory.json   # the config's memory.enabled
echo '{}' > /tmp/models.json; chmod 0644 /tmp/models.json     # the config's models (the summary role)
echo 32000 > /tmp/context.json; chmod 0644 /tmp/context.json # the config's limits.context_tokens
push() {
  api -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"openrouter_api_key\":\"$KEY\"}" "$A/secrets"
  echo -n " "
  api -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -d '{"name":"smoke","goal":"Answer the smoke test.","model":{"provider":"openrouter","id":"openai/gpt-4o-mini"},"browser":{"identities":{"managed_by_dot":true,"max_identities":20,"max_open":3}},"permissions":'"$(cat /tmp/perms.json)"',"models":'"$(cat /tmp/models.json)"',"memory":{"enabled":'"$(cat /tmp/memory.json)"'},"limits":{"max_steps_per_task":60,"context_tokens":'"$(cat /tmp/context.json)"',"max_cost_per_task_usd":1}}' "$A/config"
}
{ declare -f api push; echo "H=(-sS -H 'Authorization: Bearer $TOKEN'); A=$A; KEY=$KEY; push"; } > /tmp/push.sh
check "the host pushes the key and the config (204 204)" "[ \"\$(push)\" = '204 204' ]"
sleep 3
check "the state directory is dotengine's, 0700" "[ \"\$(stat -c '%U:%G %a' /home/dotengine/state)\" = 'dotengine:dotengine 700' ]"
check "dot cannot read the engine's state" "! su -s /bin/bash dot -c 'ls /home/dotengine/state' >/dev/null 2>&1"

# The event stream, read the way the host reads it: from its last seq,
# reconnecting after a drop, pushing the key and the config on agent.started.
STREAM=/tmp/host-stream.txt
bash "$HERE/host-stream.sh" "$TOKEN" "$STREAM" "bash /tmp/push.sh" &
SPID=$!
ev() { local id=$1 type=$2 data=$3; api -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"id\":\"$id\",\"type\":\"$type\",\"ts\":\"2026-10-04T10:00:00Z\",\"data\":$data}" "$A/events"; }
wait_event() { # file, jq filter
  for _ in $(seq 1 120); do
    # -s and any(): jq -e alone judges only the LAST event read, not whether one matched.
    if grep '^data: ' "$1" | sed 's/^data: //' | jq -s -e "any(.[]; $2)" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
check "user.message accepted (202)" "[ \"\$(ev msg-1 user.message '{\"text\":\"hello\"}')\" = 202 ]"
check "the same user.message again is accepted and ignored (202)" "[ \"\$(ev msg-1 user.message '{\"text\":\"hello\"}')\" = 202 ]"
check "message.assistant answers it, in_reply_to msg-1" "wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-1\" and .data.text==\"hello from the stand-in\"'"
# (The attribution headers go only to a verified openrouter.ai route, so a stand-in never sees them.)
check "the model request carried the key the host pushed" "grep -q '\"auth\": \"present\"' /tmp/fake-requests.jsonl"

check "a task whose model calls exec is accepted" "[ \"\$(ev task-ev-1 task.created '{\"task_id\":\"t1\",\"description\":\"RUN-EXEC id -un > /home/dot/workspace/whoami.txt; ps -o user= -p \$\$ >> /home/dot/workspace/whoami.txt; echo ran-as-\$(id -un)\",\"priority\":0}')\" = 202 ]"
check "task.started t1" "wait_event $STREAM '.type==\"task.started\" and .data.task_id==\"t1\"'"
check "tool.called exec, ok, computer.exec, with a duration" "wait_event $STREAM '.type==\"tool.called\" and .data.task_id==\"t1\" and .data.tool==\"exec\" and .data.ok==true and .data.permission==\"computer.exec\"'"
check "that tool.called names the command that ran (its first line)" "wait_event $STREAM '.type==\"tool.called\" and .data.task_id==\"t1\" and .data.tool==\"exec\" and (.data.target|startswith(\"id -un > /home/dot/workspace/whoami.txt; ps -o user=\"))'"
check "task.completed t1 with the model's answer" "wait_event $STREAM '.type==\"task.completed\" and .data.task_id==\"t1\" and (.data.summary|test(\"ran-as-dot\"))'"
check "the command ran as dot (file content)" "[ \"\$(head -1 /home/dot/workspace/whoami.txt 2>/dev/null)\" = dot ]"
check "the command ran as dot (file owner)" "[ \"\$(stat -c %U /home/dot/workspace/whoami.txt 2>/dev/null)\" = dot ]"
echo "whoami.txt: $(cat /home/dot/workspace/whoami.txt 2>/dev/null | tr '\n' ' ')"
echo "offered tools: $(tail -1 /tmp/fake-tools.jsonl | jq -c '.tools|sort')"
check "the model is offered exec and nothing outside the allowed permissions" "tail -1 /tmp/fake-tools.jsonl | jq -e '(.tools|index(\"exec\")) != null and (.tools - [\"exec\",\"exec_session\",\"list_exec_sessions\"] | length) == 0' >/dev/null"

# --- task.progress: the text the model writes beside a tool call of a task ---
check "a task whose model writes a line beside its exec call is accepted" "[ \"\$(ev task-ev-7 task.created '{\"task_id\":\"t7\",\"description\":\"SAY-RUN-EXEC Checking the workspace first. :: echo progress-ran\",\"priority\":0}')\" = 202 ]"
check "task.completed t7" "wait_event $STREAM '.type==\"task.completed\" and .data.task_id==\"t7\" and (.data.summary|test(\"progress-ran\"))'"
check "t7 reported its line once as task.progress, before the call and the completion" "grep '^data: ' $STREAM | sed 's/^data: //' | jq -s -e '[.[] | select(.data.task_id==\"t7\") | .type] == [\"task.started\",\"task.progress\",\"tool.called\",\"task.completed\"] and ([.[] | select(.type==\"task.progress\" and .data.task_id==\"t7\")] | map(.data.text) == [\"Checking the workspace first.\"])' >/dev/null"
check "the events of t7, which spent nothing, report spent_usd 0" "grep '^data: ' $STREAM | sed 's/^data: //' | jq -s -e '[.[] | select(.data.task_id==\"t7\" and (.type==\"task.progress\" or .type==\"task.completed\"))] | length == 2 and all(.data.spent_usd == 0)' >/dev/null"
check "the chat's own line beside a tool call is no progress" "[ \"\$(ev msg-narrated user.message '{\"text\":\"SAY-RUN-EXEC Chat narration. :: echo chat-ran\"}')\" = 202 ] && wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-narrated\"' && [ \"\$(grep '^data: ' $STREAM | sed 's/^data: //' | jq -c 'select(.type==\"task.progress\")' | wc -l)\" = 1 ]"

# --- kill -9 and seq resume ---
LAST=$(grep '^id: ' "$STREAM" | tail -1 | sed 's/^id: //')
echo "last seq before the crash: $LAST"
# A task the crash will cut while its command runs.
ev task-ev-2 task.created '{"task_id":"t2","description":"RUN-EXEC sleep 60; echo late","priority":0}' >/dev/null
for _ in $(seq 1 60); do pgrep -u dot -f 'sleep 60' >/dev/null && break; sleep 1; done
check "the long command runs as dot" "pgrep -u dot -f 'sleep 60' >/dev/null"
pkill -9 -u dotengine   # the engine and every process of its cgroup, as systemd's restart does
sleep 2
check "the command died with the engine that started it" "! pgrep -u dot -f 'sleep 60' >/dev/null"
start_engine
check "the restarted engine answers /health" "wait_health"
STREAM2=$STREAM
check "agent.started after the restart, read by the reconnected host" "wait_event $STREAM2 '.type==\"agent.started\" and .seq > $LAST'"
wait_key() { for _ in $(seq 1 60); do api "$A/health" | grep -q '"openrouter_configured":true' && return 0; sleep 1; done; return 1; }
check "the host pushed the key again on agent.started" "wait_key"
check "the cut call is reported once as interrupted" "wait_event $STREAM2 '.type==\"tool.called\" and .data.task_id==\"t2\" and .data.interrupted==true'"
check "the task resumes and completes" "wait_event $STREAM2 '.type==\"task.completed\" and .data.task_id==\"t2\"'"
check "a message after the restart is answered" "[ \"\$(ev msg-2 user.message '{\"text\":\"still there?\"}')\" = 202 ] && wait_event $STREAM2 '.type==\"message.assistant\" and .data.in_reply_to==\"msg-2\"'"
# --- cancel and terminate end the remote command, as dot ---
# The engine ends a command by killing the relay it started, in the relay's own process group; nothing
# else tells dot-agentd. On the closed socket dot-agentd must end the remote process group: the shell,
# the foreground command and the background child alike. (The stand-in names every call "call_0".)
gone_within() { # seconds, pattern: no process of dot matches it
  for _ in $(seq 1 $(($1*5))); do pgrep -u dot -f "$2" >/dev/null || return 0; sleep 0.2; done
  return 1
}
ev task-ev-5 task.created '{"task_id":"t5","description":"RUN-EXEC sleep 61 & sleep 62; echo late5 > /home/dot/workspace/late5.txt","priority":0}' >/dev/null
for _ in $(seq 1 60); do pgrep -u dot -f 'sleep 62' >/dev/null && pgrep -u dot -f 'sleep 61' >/dev/null && break; sleep 1; done
check "t5's command and its background child run as dot" "pgrep -u dot -f 'sleep 62' >/dev/null && pgrep -u dot -f 'sleep 61' >/dev/null"
echo "dot's processes while t5 runs:"; ps -o pid,ppid,pgid,args -u dot | cut -c1-120
ev cancel-t5 system.event '{"name":"task.cancelled","data":{"task_id":"t5"}}' >/dev/null
check "cancelling the task ended its command and its background child within 10 s" "gone_within 10 'sleep 6[12]'"
check "the cancelled task's call is reported as interrupted" "wait_event $STREAM '.type==\"tool.called\" and .data.task_id==\"t5\" and .data.interrupted==true'"
check "the cancelled command never reached its last line" "sleep 1; [ ! -e /home/dot/workspace/late5.txt ]"
ev msg-sess user.message '{"text":"RUN-SESSION sleep 63 & sleep 64"}' >/dev/null
check "an exec session starts and the model is told its id" "wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-sess\" and (.data.text|test(\"session_id\"))'"
check "the session's command and its background child run as dot" "pgrep -u dot -f 'sleep 64' >/dev/null && pgrep -u dot -f 'sleep 63' >/dev/null"
ev msg-kill user.message '{"text":"KILL-SESSION"}' >/dev/null
check "the model terminates the session" "wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-kill\"'"
check "terminating the exec session ended its command and its background child within 10 s" "gone_within 10 'sleep 6[34]'"

# --- exec on a pseudo-terminal (the tty argument): a real terminal from the real relay ---
# The program asks a question in color on a terminal; the model answers it through exec_session and
# reads the screen's text, not the byte stream (no escape sequence, no carriage return).
cat > /tmp/tty-ask.sh <<'TTYASK'
#!/bin/bash
if [ -t 0 ] && [ -t 1 ]; then echo "stdio-is-a-tty"; else echo "stdio-is-not-a-tty"; fi
echo "term=$TERM size=$(stty size)"
printf '\033[1;32mname?\033[0m '
read -r name
printf 'hello %s\n' "$name"
TTYASK
chmod 755 /tmp/tty-ask.sh
ev msg-tty1 user.message '{"text":"RUN-TTY bash /tmp/tty-ask.sh"}' >/dev/null
check "a tty exec starts a session, the program saw a terminal of 80x24 with a TERM, and the result has no escape sequence" "wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-tty1\" and (.data.text|test(\"stdio-is-a-tty\")) and (.data.text|test(\"term=xterm-256color size=24 80\")) and (.data.text|test(\"name\\\\? \")) and (.data.text|test(\"session_id\")) and (.data.text|test(\"\\u001b\")|not) and (.data.text|test(\"\\r\")|not)'"
check "the terminal program runs as dot, waiting for its answer" "pgrep -u dot -f 'bash /tmp/tty-ask.sh' >/dev/null"
ev msg-tty2 user.message '{"text":"TTY-ANSWER Ada"}' >/dev/null
check "the answer reaches the program: the model reads its reply and the exit, with no escape sequence or carriage return" "wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-tty2\" and (.data.text|test(\"hello Ada\")) and (.data.text|test(\"Exit code: 0\")) and (.data.text|test(\"\\u001b\")|not) and (.data.text|test(\"\\r\")|not)'"
check "the terminal program ended" "gone_within 10 'bash /tmp/tty-ask.sh'"

# --- SIGTERM while a tool runs: the engine is gone within systemd's TimeoutStopSec=30 ---
ev task-ev-6 task.created '{"task_id":"t6","description":"RUN-EXEC sleep 70; echo late6 > /home/dot/workspace/late6.txt","priority":0}' >/dev/null
for _ in $(seq 1 60); do pgrep -u dot -f 'sleep 70' >/dev/null && break; sleep 1; done
check "t6's long command runs as dot" "pgrep -u dot -f 'sleep 70' >/dev/null"
EPID6=$(pgrep -o -u dotengine -f 'python.*-m nanobot')
STOP_T0=$(date +%s.%N)
kill -TERM "$EPID6"
for _ in $(seq 1 400); do kill -0 "$EPID6" 2>/dev/null || break; sleep 0.1; done
STOP_T1=$(date +%s.%N)
STOP_S=$(awk -v a="$STOP_T0" -v b="$STOP_T1" 'BEGIN { printf "%.1f", b - a }')
echo "MEASURED: the engine exited $STOP_S s after SIGTERM with a tool running"
check "SIGTERM with a tool running stops the engine within systemd's 30 s ($STOP_S s)" "awk -v s=$STOP_S 'BEGIN { exit !(s < 30) }'"
check "that stop left no process of the engine and no command of dot" "! pgrep -u dotengine >/dev/null && ! pgrep -u dot -f 'sleep 70' >/dev/null"
start_engine
check "the restarted engine answers /health (stopped with a tool running)" "wait_health && wait_key"
check "the task t6 the stop cut resumes and completes" "wait_event $STREAM '.type==\"task.completed\" and .data.task_id==\"t6\"'"

# --- approvals (architecture 8.4): ask parks the call, the decision survives kill -9 ---
echo '{"computer.exec":"ask"}' > /tmp/perms.json
check "the host pushes a config where exec asks (204 204)" "[ \"\$(push)\" = '204 204' ]"
st() { api "$A/state"; }
ev task-ev-3 task.created '{"task_id":"t3","description":"RUN-EXEC echo approved-ran > /home/dot/workspace/approved.txt; echo approved-out","priority":0}' >/dev/null
check "approval.requested for t3's exec, with its exact arguments" "wait_event $STREAM '.type==\"approval.requested\" and .data.task_id==\"t3\" and .data.tool==\"exec\" and .data.permission==\"computer.exec\" and (.data.arguments.command|test(\"approved-ran\"))'"
AP3=$(grep '^data: ' $STREAM | sed 's/^data: //' | jq -r 'select(.type=="approval.requested" and .data.task_id=="t3") | .data.approval_id' | head -1)
echo "t3 approval: $AP3"
sleep 3
check "the parked call did not run" "[ ! -e /home/dot/workspace/approved.txt ]"
check "the task waits: neither completed nor failed" "! grep '^data: ' $STREAM | sed 's/^data: //' | jq -s -e 'any(.[]; (.type==\"task.completed\" or .type==\"task.failed\") and .data.task_id==\"t3\")' >/dev/null"
check "/state says WAITING_APPROVAL on that approval" "st | jq -e --arg id \"$AP3\" '.state==\"WAITING_APPROVAL\" and .pending_approval==\$id' >/dev/null"
LAST3=$(grep '^id: ' "$STREAM" | tail -1 | sed 's/^id: //')
pkill -9 -u dotengine
sleep 2
start_engine
check "the restarted engine answers /health (approval pending)" "wait_health && wait_key"
check "the approval is still pending after kill -9" "st | jq -e --arg id \"$AP3\" '.pending_approval==\$id' >/dev/null"
sleep 3
check "the restart asked nothing new and did not resume the parked task" "[ \"\$(grep '^data: ' $STREAM | sed 's/^data: //' | jq -c 'select(.type==\"approval.requested\" and .data.task_id==\"t3\")' | wc -l)\" = 1 ] && [ ! -e /home/dot/workspace/approved.txt ]"
check "approval.received approve accepted (202)" "[ \"\$(ev ap-3 approval.received '{\"approval_id\":\"'$AP3'\",\"decision\":\"approve\"}')\" = 202 ]"
check "tool.called t3 exec, decision ask, ok" "wait_event $STREAM '.type==\"tool.called\" and .data.task_id==\"t3\" and .data.decision==\"ask\" and .data.ok==true and .seq > $LAST3'"
check "the approved call ran as dot" "[ \"\$(stat -c %U /home/dot/workspace/approved.txt 2>/dev/null)\" = dot ] && grep -q approved-ran /home/dot/workspace/approved.txt"
check "task.completed t3 with the call's result in the continuation" "wait_event $STREAM '.type==\"task.completed\" and .data.task_id==\"t3\" and (.data.summary|test(\"approved-out\"))'"
check "it ran once: one tool.called for t3" "[ \"\$(grep '^data: ' $STREAM | sed 's/^data: //' | jq -c 'select(.type==\"tool.called\" and .data.task_id==\"t3\")' | wc -l)\" = 1 ]"

# A chat call, rejected with a note.
ev msg-3 user.message '{"text":"RUN-EXEC touch /home/dot/workspace/rejected.txt"}' >/dev/null
check "approval.requested for the chat's exec (no task)" "wait_event $STREAM '.type==\"approval.requested\" and (.data.task_id|not) and (.data.arguments.command|test(\"rejected.txt\"))'"
APC=$(grep '^data: ' $STREAM | sed 's/^data: //' | jq -r 'select(.type=="approval.requested" and (.data.task_id|not)) | .data.approval_id' | tail -1)
check "approval.received reject accepted (202)" "[ \"\$(ev ap-c approval.received '{\"approval_id\":\"'$APC'\",\"decision\":\"reject\",\"note\":\"leave it\"}')\" = 202 ]"
check "the chat hears the rejection" "wait_event $STREAM '.type==\"message.assistant\" and .data.text==\"rejection noted\"'"
check "the rejected call never ran" "[ ! -e /home/dot/workspace/rejected.txt ]"

# An approved call cut by kill -9 while it runs: reported once as interrupted, never run again.
ev task-ev-4 task.created '{"task_id":"t4","description":"RUN-EXEC sleep 45; echo late4 > /home/dot/workspace/late4.txt","priority":0}' >/dev/null
check "approval.requested for t4" "wait_event $STREAM '.type==\"approval.requested\" and .data.task_id==\"t4\"'"
AP4=$(grep '^data: ' $STREAM | sed 's/^data: //' | jq -r 'select(.type=="approval.requested" and .data.task_id=="t4") | .data.approval_id' | head -1)
ev ap-4 approval.received '{"approval_id":"'$AP4'","decision":"approve"}' >/dev/null
for _ in $(seq 1 60); do pgrep -u dot -f 'sleep 45' >/dev/null && break; sleep 1; done
check "the approved long call runs as dot" "pgrep -u dot -f 'sleep 45' >/dev/null"
pkill -9 -u dotengine
sleep 2
start_engine
check "the restarted engine answers /health (approved call cut)" "wait_health && wait_key"
check "the cut approved call is reported as interrupted, decision ask" "wait_event $STREAM '.type==\"tool.called\" and .data.task_id==\"t4\" and .data.decision==\"ask\" and .data.interrupted==true'"
check "t4 resumes, told it was interrupted, and completes" "wait_event $STREAM '.type==\"task.completed\" and .data.task_id==\"t4\" and .data.summary==\"resumed and finished\"'"
check "the cut call was not run again" "! pgrep -u dot -f 'sleep 45' >/dev/null && [ ! -e /home/dot/workspace/late4.txt ]"
check "/state is IDLE with nothing pending" "st | jq -e '.state==\"IDLE\" and .pending_approval==null' >/dev/null"

# --- the offered tools follow the permission map (the pin on exec, exec_session and
#     list_exec_sessions above holds for that one map; these are the others) ---
# A config is pushed, then a chat turn runs; the request that turn made to the model
# lists the tools it was offered. The expected list is the permission table of
# nanobot/dots/permissions.py, written out here: a tool the engine offers that the
# table does not name (an MCP tool, a core tool left in) makes a list differ.
offered_with() { # n, permissions json, memory.enabled: the tools the model is offered in a chat turn
  echo "$2" > /tmp/perms.json; echo "$3" > /tmp/memory.json
  [ "$(push)" = '204 204' ] || return 1
  [ "$(ev "msg-tools-$1" user.message '{"text":"which tools?"}')" = 202 ] || return 1
  wait_event $STREAM ".type==\"message.assistant\" and .data.in_reply_to==\"msg-tools-$1\"" || return 1
  tail -1 /tmp/fake-tools.jsonl | jq -c '.tools|sort'
}
check_offered() { # n, label, permissions json, memory.enabled, expected tools (sorted JSON)
  local got; got=$(offered_with "$1" "$3" "$4")
  echo "offered ($2): $got"
  check "offered tools: $2" "[ '$got' = '$5' ]"
}
check_offered 1 "every permission granted (files.write asks), memory on" \
  '{"computer.exec":"allow","files.read":"allow","files.write":"ask","memory.read":"allow","automations":"allow"}' true \
  '["apply_patch","cron","edit_file","exec","exec_session","find_files","grep","list_dir","list_exec_sessions","memory_get","memory_search","read_file","write_file"]'
check_offered 2 "exec denied, files.read allowed, the rest missing from the map (deny)" \
  '{"computer.exec":"deny","files.read":"allow","memory.read":"deny"}' true \
  '["find_files","grep","list_dir","read_file"]'
check_offered 3 "memory off: no memory tool even with memory.read allowed" \
  '{"computer.exec":"allow","memory.read":"allow"}' false \
  '["exec","exec_session","list_exec_sessions"]'
check_offered 4 "an empty permission map offers nothing" '{}' true '[]'
# A call of a tool the model was not offered (the stand-in makes it anyway) never runs: the turn's
# registry holds only the offered tools, so the call fails as an unknown tool before the gate is asked
# (design: an unknown tool never reaches the gate; tool.called reports it with decision allow, ok false).
echo '{"computer.exec":"deny"}' > /tmp/perms.json
check "the host pushes a config where exec is denied (204 204)" "[ \"\$(push)\" = '204 204' ]"
ev msg-deny user.message '{"text":"RUN-EXEC touch /home/dot/workspace/denied.txt"}' >/dev/null
check "a call of the tool that was not offered is reported as tool.called, not ok" "wait_event $STREAM '.type==\"tool.called\" and .data.tool==\"exec\" and .data.ok==false and .data.permission==\"computer.exec\"'"
check "the model is told the tool is not found, and the chat answers" "wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-deny\" and (.data.text|test(\"Tool .exec. not found\"))'"
check "the call of the tool that was not offered never ran" "sleep 2; [ ! -e /home/dot/workspace/denied.txt ]"
echo '{"computer.exec":"allow"}' > /tmp/perms.json; echo true > /tmp/memory.json
check "the host pushes the allow-everything config again (204 204)" "[ \"\$(push)\" = '204 204' ]"

# --- memory.written: a note is a file of /home/dot/memory, and the file tools report the ones they write ---
echo '{"computer.exec":"allow","files.write":"allow","memory.read":"allow"}' > /tmp/perms.json
check "the host pushes a config where the Dot may write files and read its memory (204 204)" "[ \"\$(push)\" = '204 204' ]"
check "a chat asks the Dot to write a note two directories deep" "[ \"\$(ev msg-note-1 user.message '{\"text\":\"WRITE-NOTE trips/smoke-note.md :: smoke-needle in a note\"}')\" = 202 ] && wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-note-1\"'"
check "the note is a file of the memory directory, owned by dot" "[ \"\$(cat /home/dot/memory/trips/smoke-note.md 2>/dev/null)\" = 'smoke-needle in a note' ] && [ \"\$(stat -c %U /home/dot/memory/trips/smoke-note.md)\" = dot ]"
check "write_file reported memory.written with the path relative to the memory directory, right after its tool.called" "grep '^data: ' $STREAM | sed 's/^data: //' | jq -s -e '[.[] | select((.type==\"tool.called\" and .data.tool==\"write_file\") or .type==\"memory.written\") | [.type, (.data.key // .data.tool), (.data.ok // null)]] == [[\"tool.called\",\"write_file\",true],[\"memory.written\",\"trips/smoke-note.md\",null]]' >/dev/null"
check "that tool.called names the path it wrote and none of what it wrote" "grep '^data: ' $STREAM | sed 's/^data: //' | jq -s -e '[.[] | select(.type==\"tool.called\" and .data.tool==\"write_file\") | .data.target] == [\"/home/dot/memory/trips/smoke-note.md\"]' >/dev/null"
check "the tool.called of an exec call names its command with the credential masked" "[ \"\$(ev msg-target user.message '{\"text\":\"RUN-EXEC echo smoke-target --token hunter2-smoke\"}')\" = 202 ] && wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-target\"' && grep '^data: ' $STREAM | sed 's/^data: //' | jq -s -e '[.[] | select(.type==\"tool.called\" and (.data.target // \"\" | startswith(\"echo smoke-target\"))) | .data.target] == [\"echo smoke-target --token ***\"]' >/dev/null"
check "memory_search finds the note the Dot wrote" "[ \"\$(ev msg-note-2 user.message '{\"text\":\"FIND-NOTE smoke-needle\"}')\" = 202 ] && wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-note-2\" and (.data.text|test(\"trips/smoke-note.md\"))'"
check "a file written outside the memory directory (through ../) is no note" "[ \"\$(ev msg-note-3 user.message '{\"text\":\"WRITE-NOTE ../workspace/not-a-note.md :: x\"}')\" = 202 ] && wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-note-3\"' && [ -e /home/dot/workspace/not-a-note.md ] && [ \"\$(grep '^data: ' $STREAM | sed 's/^data: //' | jq -c 'select(.type==\"memory.written\")' | wc -l)\" = 1 ]"
echo '{"computer.exec":"allow"}' > /tmp/perms.json
check "the host pushes the allow-everything config once more (204 204)" "[ \"\$(push)\" = '204 204' ]"

# --- limits.max_cost_per_task_usd (1 in the pushed config): the cap stops a task and a chat turn, and holds after kill -9 ---
# The stand-in reports a cost of 0.6 in every response of a conversation whose last user text has a COST 0.6 line,
# and REPEAT-EXEC makes it call exec after every result: only the cap ends such a task.
ev task-ev-8 task.created '{"task_id":"t8","description":"COST 0.6\nREPEAT-EXEC echo spend","priority":0}' >/dev/null
check "t8 (0.6 a response, a model that never stops) fails with the cap's text, having spent 1.2" "wait_event $STREAM '.type==\"task.failed\" and .data.task_id==\"t8\" and .data.error==\"stopped: the task reached limits.max_cost_per_task_usd (spent 1.2000 USD of 1.00)\"'"
check "the failure of t8 reports what the task spent: spent_usd 1.2" "wait_event $STREAM '.type==\"task.failed\" and .data.task_id==\"t8\" and .data.spent_usd==1.2'"
check "t8 made two requests: the third was never asked (two tool.called, no task.completed)" "[ \"\$(grep '^data: ' $STREAM | sed 's/^data: //' | jq -c 'select(.type==\"tool.called\" and .data.task_id==\"t8\")' | wc -l)\" = 2 ] && [ \"\$(grep -c 'REPEAT-EXEC echo spend' /tmp/fake-tools.jsonl)\" = 2 ]"
ev msg-spend user.message '{"text":"COST 0.6\nREPEAT-EXEC echo chat-spend"}' >/dev/null
check "a chat turn that spent the cap answers with the turn's text" "wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-spend\" and .data.text==\"I could not answer: stopped: the turn reached limits.max_cost_per_task_usd (spent 1.2000 USD of 1.00)\"'"
check "the answer of that chat turn reports the turn's spend: spent_usd 1.2" "wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-spend\" and .data.spent_usd==1.2'"
# The first response of t9 is paid (0.6) and its command runs; the engine is killed then. The restarted engine
# resumes the task from the spend it stored: one more response ends it. Were the spend lost with the process,
# a third request would be made.
ev task-ev-9 task.created '{"task_id":"t9","description":"COST 0.6\nREPEAT-EXEC sleep 4","priority":0}' >/dev/null
for _ in $(seq 1 60); do pgrep -u dot -f 'sleep 4$' >/dev/null && break; sleep 0.5; done
check "t9's first command runs as dot" "pgrep -u dot -f 'sleep 4\$' >/dev/null"
pkill -9 -u dotengine
sleep 2
start_engine
check "the restarted engine answers /health (the cap's task cut)" "wait_health && wait_key"
check "t9 fails with the cap's text after one more response: the spend survived the kill" "wait_event $STREAM '.type==\"task.failed\" and .data.task_id==\"t9\" and .data.error==\"stopped: the task reached limits.max_cost_per_task_usd (spent 1.2000 USD of 1.00)\"'"
check "the failure of t9 reports the spend of both processes: spent_usd 1.2" "wait_event $STREAM '.type==\"task.failed\" and .data.task_id==\"t9\" and .data.spent_usd==1.2'"
check "t9 asked the model twice in all: once before the kill, once after" "[ \"\$(grep -c 'REPEAT-EXEC sleep 4' /tmp/fake-tools.jsonl)\" = 2 ]"

# --- models.summary: a thread that outgrows limits.context_tokens is summarized by the role's model ---
# The window is 8000 tokens, the answer's room 4096 and the safety buffer 1024: a request over 2880 tokens is
# compacted, and the summary of it may read 3904. Each of the five messages is about 900 tokens, so the thread
# outgrows its request budget within them, while the summary's input still fits (a summary that does not fit is a
# mechanical digest and asks no model). The stand-in answers each message with the same short text.
echo '{"summary":"smoke/summarizer"}' > /tmp/models.json; echo 8000 > /tmp/context.json
check "the host pushes a config with a summary model and an 8000 token window (204 204)" "[ \"\$(push)\" = '204 204' ]"
LONG=$(yes 'alpha beta gamma delta epsilon zeta' | head -n 130 | tr '\n' ' ')
for n in 1 2 3 4 5; do
  ev "msg-long-$n" user.message "{\"text\":\"$n $LONG\"}" >/dev/null
  wait_event $STREAM ".type==\"message.assistant\" and .data.in_reply_to==\"msg-long-$n\"" || break
done
check "the five long messages were answered" "wait_event $STREAM '.type==\"message.assistant\" and .data.in_reply_to==\"msg-long-5\"'"
check "a request went to the summary role's model, with no tool in it" "jq -s -e 'any(.[]; .model==\"smoke/summarizer\" and (.tools|length)==0)' /tmp/fake-tools.jsonl >/dev/null"
check "every request the summary role's model got was offered no tool (it never answers a turn)" "jq -s -e '[.[] | select(.model==\"smoke/summarizer\")] | length > 0 and all(.[]; (.tools|length)==0)' /tmp/fake-tools.jsonl >/dev/null"
check "the turns themselves went to the Dot's own model, offered the tools of the permission map" "jq -s -e '[.[] | select(.model==\"openai/gpt-4o-mini\")] | length >= 5 and (last | .tools | index(\"exec\") != null)' /tmp/fake-tools.jsonl >/dev/null"
echo '{}' > /tmp/models.json; echo 32000 > /tmp/context.json
check "the host pushes the config without a summary model again (204 204)" "[ \"\$(push)\" = '204 204' ]"

# --- what the model is sent, read whole ---
# Here, after the last model turn of the run, so the checks judge EVERY request:
# the allow-mode chat and tasks, the resumes after each restart, the ask-mode
# turns with their approval and rejection continuations (where approval wording
# would show up) and the permission-map turns above. Nothing below this point
# calls the model.
echo "requests logged whole: $(wc -l < "$FULL" 2>/dev/null)"
check "a Dot run's request has a system prompt and an exec tool schema" "req_prompt_and_exec"
echo "banned text the model is sent (pins prompt-text):"; req_banned_seen | sed 's/^/  | /'
check_pinned prompt-text "no request's system prompt or exec description names /approve, approval-pending, Guardian, elevated" "req_no_approval_text"
check_pinned exec-schema "no request's exec tool schema has an elevated property" "req_exec_schema_clean"

sleep 3
pkill -f host-stream.sh; kill $SPID 2>/dev/null; wait $SPID 2>/dev/null
# Everything committed, read again from 0: what the host received across the crash must be exactly that.
ALL=/tmp/stream-all.txt
timeout 5 curl "${H[@]}" -N "$A/events/stream?after=0" > "$ALL" 2>/dev/null
seqs() { grep '^id: ' "$1" | sed 's/^id: //'; }
check "seqs of the full stream are 1..N without a gap" "[ \"\$(seqs $ALL | tr '\n' ' ')\" = \"\$(seq 1 \$(seqs $ALL | wc -l) | tr '\n' ' ')\" ]"
check "the host received every event exactly once across the crash (no loss, no repeat)" "[ \"\$(seqs $STREAM | tr '\n' ' ')\" = \"\$(seqs $ALL | tr '\n' ' ')\" ]"
check "event ids are unique" "[ \"\$(grep '^data: ' $ALL | sed 's/^data: //' | jq -r .id | sort | uniq -d | wc -l)\" = 0 ]"
check "tool.called for t2 appears once as interrupted" "[ \"\$(grep '^data: ' $ALL | sed 's/^data: //' | jq -c 'select(.type==\"tool.called\" and .data.task_id==\"t2\" and .data.interrupted==true)' | wc -l)\" = 1 ]"
check "agent.started six times in all (six starts)" "[ \"\$(grep '^data: ' $ALL | sed 's/^data: //' | jq -c 'select(.type==\"agent.started\")' | wc -l)\" = 6 ]"
echo "event types: $(grep '^data: ' $ALL | sed 's/^data: //' | jq -r .type | sort | uniq -c | tr '\n' ' ')"

# --- the key on disk ---
check "the key is in no file of the engine, the config or the Dot" "! grep -rIl \"$KEY\" /home/dotengine /etc/invisible-dots /home/dot /run/invisible-dots /run/invisible-dots-agent 2>/dev/null | grep -q ."
check "the key is in no SQLite file either" "! find /home/dotengine -type f -exec grep -l -a \"$KEY\" {} + 2>/dev/null | grep -q ."
check "the key is in no engine log" "! grep -rIl \"$KEY\" /tmp/engine.log 2>/dev/null | grep -q ."
check "the key is not in the environment of any process" "! grep -a -l \"$KEY\" /proc/[0-9]*/environ 2>/dev/null | grep -q ."
# --- a graceful stop: SIGTERM, as systemd stops the unit (TimeoutStopSec=30) ---
echo "engine processes before the stop:"; ps -o pid,ppid,etimes,args -u dotengine | cut -c1-160
EPID=$(pgrep -o -u dotengine -f 'python.*-m nanobot')
kill -TERM "$EPID"
for _ in $(seq 1 30); do pgrep -u dotengine >/dev/null || break; sleep 1; done
echo "engine processes after the stop:"; ps -o pid,ppid,etimes,args -u dotengine | cut -c1-160
check "SIGTERM stops the engine within systemd's 30 s" "! kill -0 $EPID 2>/dev/null"
check "the stop leaves no process of the engine" "! pgrep -u dotengine >/dev/null"
check "the stop is logged as a clean shutdown, not a crash" "tail -40 /tmp/engine.log | grep -q 'Dot API stopped' && ! tail -40 /tmp/engine.log | grep -q 'Traceback'"
# --- what the stopped engine left: its state, its config, its logs ---
# (The old engine kept a config file for root to write; this one has none, so the
# same questions are asked of what it does keep.)
check "the engine wrote nothing under /etc/invisible-dots (only the host's token file is there)" "[ \"\$(ls -A /etc/invisible-dots)\" = config.json ]"
check "everything under the engine's home is dotengine's, and its home and state directories are 0700 (they close the files inside)" "[ -z \"\$(find /home/dotengine ! -user dotengine 2>/dev/null)\" ] && [ \"\$(stat -c %a /home/dotengine /home/dotengine/state | tr '\n' ' ')\" = '700 700 ' ]"
check "dot cannot read the engine's database by path" "! su -s /bin/bash dot -c 'cat /home/dotengine/state/engine.sqlite' >/dev/null 2>&1"
# The engine's config is the runtime_config row of that database (the old engine's file
# was root:dotengine 0640 and dot could not read it): dot reaches neither the file, nor
# the row through sqlite, nor any file under the engine's home.
cat > /tmp/dot-read-config.py <<'PYEOF'
import sqlite3
sqlite3.connect("file:/home/dotengine/state/engine.sqlite?mode=ro", uri=True).execute("select value_json from dots_kv")
PYEOF
chmod 0644 /tmp/dot-read-config.py
check "dot cannot see the engine's database file at all (it exists: root sees it)" "[ -e /home/dotengine/state/engine.sqlite ] && ! su -s /bin/bash dot -c 'test -e /home/dotengine/state/engine.sqlite' 2>/dev/null"
check "dot cannot read the stored config row through sqlite" "! su -s /bin/bash dot -c 'python3 /tmp/dot-read-config.py' >/dev/null 2>&1"
check "dot finds no file under the engine's home" "[ -z \"\$(su -s /bin/bash dot -c 'find /home/dotengine -type f' 2>/dev/null)\" ]"
# No counterpart on purpose, the feature is gone: the sudoers rule and its visudo parse
# (the engine has no privilege), the config file's mode and its 'source: memory' key
# reference (there is no config file; the stored-config check below says no key is kept),
# /tmp/openclaw (the directory no longer exists; the key sweep over /tmp, /var/log,
# /var/tmp and /dev/shm below covers every log the engine could write).
cat > /tmp/read-config.py <<'PYEOF'
import sqlite3
conn = sqlite3.connect("file:/home/dotengine/state/engine.sqlite?mode=ro", uri=True)
print(conn.execute("select value_json from dots_kv where key = 'runtime_config'").fetchone()[0])
PYEOF
chmod 0644 /tmp/read-config.py
su -s /bin/bash dotengine -c "$ENGINE_PY -I -B /tmp/read-config.py" > /tmp/stored-config.json 2>/tmp/stored-config.err
echo "stored config: $(cut -c1-300 /tmp/stored-config.json)"
check "the engine stores the config the host pushed: the permission map, the model, no key" "jq -e '.permissions.\"computer.exec\" == \"allow\" and .model.id == \"openai/gpt-4o-mini\" and ([.. | strings | test(\"sk-or-\")] | any | not) and (has(\"openrouter_api_key\") | not)' /tmp/stored-config.json >/dev/null"
check "the key is in no log, no stream and no temporary file of the run (the push script holds it by construction)" "! grep -rIl \"$KEY\" /tmp /var/log /var/tmp /dev/shm --exclude=push.sh 2>/dev/null | grep -q ."
# --- the engine runs nothing but the Dot's engine ---
check "any other command is refused" "! su -s /bin/bash dotengine -c '$ENGINE_PY -I -B -m nanobot status' >/tmp/refused-cmd.log 2>&1 && grep -q 'runs only' /tmp/refused-cmd.log"
check "--version answers" "$ENGINE_PY -I -B -m nanobot --version | grep -q '^invisible_dots engine '"
# --- the image: the golden venv from the lock, the engine's source from the runtime disk ---
check "the engine's code is the runtime disk's, found through the venv's .pth file" "[ \"\$(su -s /bin/bash dotengine -c \"$ENGINE_PY -I -B -c 'import nanobot; print(nanobot.__file__)'\")\" = /opt/invisible-dots/engine/nanobot/__init__.py ]"
check "the venv is root's and dotengine cannot write into it" "[ \"\$(stat -c %U /opt/invisible-dots-engine/requirements.lock)\" = root ] && ! su -s /bin/bash dotengine -c 'touch /opt/invisible-dots-engine/x' 2>/dev/null"
check "no bytecode was written on the runtime disk (python -B)" "! find /opt/invisible-dots/engine -name __pycache__ | grep -q ."
check "the venv's lock is the runtime disk's lock" "cmp -s /opt/invisible-dots-engine/requirements.lock /opt/invisible-dots/engine/requirements.lock"
cp /opt/invisible-dots/engine/requirements.lock /tmp/requirements.lock.orig
echo '# a lock the golden image was not built from' >> /opt/invisible-dots/engine/requirements.lock
su -s /bin/bash dotengine -c "timeout 60 bash /tmp/engine.sh" > /tmp/lock-refuse.log 2>&1; LOCK_RC=$?
check "the engine refuses to start when the runtime disk's lock differs from the venv's" "[ $LOCK_RC = 1 ] && grep -q 'built from another requirements lock: build a new golden image' /tmp/lock-refuse.log"
cp /tmp/requirements.lock.orig /opt/invisible-dots/engine/requirements.lock
check "the runtime disk's lock is restored and equal again" "cmp -s /opt/invisible-dots-engine/requirements.lock /opt/invisible-dots/engine/requirements.lock"
# --- the startup assertion ---
pkill -9 -u dotengine; sleep 1
echo "OPENROUTER_API_KEY=$KEY" > /home/dotengine/state/.env; chown dotengine /home/dotengine/state/.env
su -s /bin/bash dotengine -c "timeout 60 bash /tmp/engine.sh" > /tmp/refuse.log 2>&1
check "the engine refuses to start with a key in a dotenv file" "grep -q 'refusing to start' /tmp/refuse.log && ! grep -q \"$KEY\" /tmp/refuse.log"
rm -f /home/dotengine/state/.env

echo "== engine log tail"; tail -25 /tmp/engine.log
echo "== agentd log tail"; tail -8 /tmp/agentd.log
echo "pinned removals: $PIN_REMOVALS"
echo "SMOKE: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = 0 ] && [ "$SKIP" = 0 ]
