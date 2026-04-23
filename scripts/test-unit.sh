#!/usr/bin/env bash
#
# Run unit tests for library modules (no pi dependency).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Unit Tests ==="
echo ""

echo "--- task-queue ---"
npx tsx "$PROJECT_DIR/tests/task-queue.test.ts"
echo ""

echo "--- agent-config ---"
npx tsx "$PROJECT_DIR/tests/agent-config.test.ts"
echo ""

echo "--- watch-queue ---"
npx tsx "$PROJECT_DIR/tests/watch-queue.test.ts"
echo ""

echo "=== All unit tests passed ==="
