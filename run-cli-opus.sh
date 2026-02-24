#!/usr/bin/env bash
unset CLAUDECODE
cd /home/steve/fj/agent-investigation/cli-opus/app
cat /home/steve/fj/agent-investigation/cli-prompt.md \
  | claude -p \
    --model opus \
    --output-format stream-json \
    --dangerously-skip-permissions \
    --no-session-persistence \
    --verbose \
  > /home/steve/fj/agent-investigation/logs/cli-opus.jsonl 2>&1
echo "EXIT: $?" >> /home/steve/fj/agent-investigation/logs/cli-opus-done.txt
