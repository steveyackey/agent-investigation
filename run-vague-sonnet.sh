#!/usr/bin/env bash
unset CLAUDECODE
cd /home/steve/fj/agent-investigation/vague-sonnet/app
cat /home/steve/fj/agent-investigation/vague-cli-prompt.md \
  | claude -p \
    --model sonnet \
    --output-format stream-json \
    --dangerously-skip-permissions \
    --no-session-persistence \
    --verbose \
  > /home/steve/fj/agent-investigation/logs/vague-sonnet.jsonl 2>&1
echo "EXIT: $?" >> /home/steve/fj/agent-investigation/logs/vague-sonnet-done.txt
