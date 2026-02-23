#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Three-Way Agent Pipeline Comparison ==="
echo "Started at: $(date -Iseconds)"
echo ""

# Ensure directories exist
mkdir -p logs v0/app v1/app v2/app

# Record start time
START_TIME=$(date +%s)

echo "Launching all 3 runners in parallel..."
echo ""

# v0: Bare prompt (single SDK call)
echo "[v0] Starting bare prompt runner..."
(cd v0 && bun run run.ts) 2>&1 | tee logs/v0.log &
V0_PID=$!

# v1: Existing pipeline (unchanged)
echo "[v1] Starting original pipeline..."
(cd v1 && bun run src/index.ts --prd ../prompt.md) 2>&1 | tee logs/v1.log &
V1_PID=$!

# v2: Optimized pipeline
echo "[v2] Starting optimized pipeline..."
(cd v2 && bun run src/index.ts --prd ../prompt.md) 2>&1 | tee logs/v2.log &
V2_PID=$!

echo ""
echo "PIDs: v0=$V0_PID  v1=$V1_PID  v2=$V2_PID"
echo "Logs: logs/v0.log  logs/v1.log  logs/v2.log"
echo ""
echo "Waiting for all runners to complete..."

# Wait for each and capture exit codes
V0_EXIT=0; wait $V0_PID || V0_EXIT=$?
V1_EXIT=0; wait $V1_PID || V1_EXIT=$?
V2_EXIT=0; wait $V2_PID || V2_EXIT=$?

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "=== All runners complete ==="
echo "Total wall-clock time: ${ELAPSED}s ($(( ELAPSED / 60 ))m $(( ELAPSED % 60 ))s)"
echo ""
echo "Exit codes:"
echo "  v0: $V0_EXIT"
echo "  v1: $V1_EXIT"
echo "  v2: $V2_EXIT"
echo ""
echo "Check logs/ for detailed output."
echo "Run quality checks with:"
echo "  (cd v0/app && cargo build && cargo test)"
echo "  (cd v1/app && cargo build && cargo test)"
echo "  (cd v2/app && cargo build && cargo test)"
