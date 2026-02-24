#!/usr/bin/env bash
unset CLAUDECODE
cd /home/steve/fj/agent-investigation/dotnet-raw/app
cat /home/steve/fj/agent-investigation/dotnet-raw-prompt.md \
  | claude -p \
    --model opus \
    --output-format stream-json \
    --dangerously-skip-permissions \
    --no-session-persistence \
    --verbose \
  > /home/steve/fj/agent-investigation/logs/dotnet-raw.jsonl 2>&1
echo "EXIT: $?" >> /home/steve/fj/agent-investigation/logs/dotnet-raw-done.txt
