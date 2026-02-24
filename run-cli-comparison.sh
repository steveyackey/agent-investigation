#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="$BASE_DIR/cli-prompt.md"
PROMPT="$(cat "$PROMPT_FILE")"

mkdir -p "$BASE_DIR/logs"
mkdir -p "$BASE_DIR/cli-opus/app"
mkdir -p "$BASE_DIR/cli-sonnet/app"

echo "=== CLI Comparison: Opus vs Sonnet ==="
echo "Prompt: $(wc -c < "$PROMPT_FILE") bytes"
echo ""

# Run Opus
echo "[$(date -Iseconds)] Starting cli-opus..."
START_OPUS=$(date +%s%3N)
claude -p "$PROMPT" \
  --model opus \
  --output-format stream-json \
  --dangerously-skip-permissions \
  --setting-sources "" \
  --no-session-persistence \
  --add-dir "$BASE_DIR/cli-opus/app" \
  2>/dev/null \
  | tee "$BASE_DIR/logs/cli-opus.jsonl" \
  | while IFS= read -r line; do
      type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
      case "$type" in
        result)
          cost=$(echo "$line" | jq -r '.total_cost_usd // "?"')
          turns=$(echo "$line" | jq -r '.num_turns // "?"')
          echo "[cli-opus] DONE: cost=\$$cost turns=$turns"
          ;;
        assistant)
          # Print text content inline
          echo "$line" | jq -r '.message.content[]? | select(.type=="text") | .text' 2>/dev/null | tr -d '\n'
          ;;
      esac
    done
END_OPUS=$(date +%s%3N)
OPUS_MS=$((END_OPUS - START_OPUS))
echo ""
echo "[$(date -Iseconds)] cli-opus finished in ${OPUS_MS}ms"
echo ""

# Run Sonnet
echo "[$(date -Iseconds)] Starting cli-sonnet..."
START_SONNET=$(date +%s%3N)
claude -p "$PROMPT" \
  --model sonnet \
  --output-format stream-json \
  --dangerously-skip-permissions \
  --setting-sources "" \
  --no-session-persistence \
  --add-dir "$BASE_DIR/cli-sonnet/app" \
  2>/dev/null \
  | tee "$BASE_DIR/logs/cli-sonnet.jsonl" \
  | while IFS= read -r line; do
      type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
      case "$type" in
        result)
          cost=$(echo "$line" | jq -r '.total_cost_usd // "?"')
          turns=$(echo "$line" | jq -r '.num_turns // "?"')
          echo "[cli-sonnet] DONE: cost=\$$cost turns=$turns"
          ;;
        assistant)
          echo "$line" | jq -r '.message.content[]? | select(.type=="text") | .text' 2>/dev/null | tr -d '\n'
          ;;
      esac
    done
END_SONNET=$(date +%s%3N)
SONNET_MS=$((END_SONNET - START_SONNET))
echo ""
echo "[$(date -Iseconds)] cli-sonnet finished in ${SONNET_MS}ms"
echo ""

echo "=== Summary ==="
echo "Opus:   ${OPUS_MS}ms"
echo "Sonnet: ${SONNET_MS}ms"
