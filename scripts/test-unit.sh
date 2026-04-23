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

echo "--- queue-lock ---"
npx tsx "$PROJECT_DIR/tests/queue-lock.test.ts"
echo ""

echo "--- session-archive ---"
npx tsx "$PROJECT_DIR/tests/session-archive.test.ts"
echo ""

echo "--- agent-config ---"
npx tsx "$PROJECT_DIR/tests/agent-config.test.ts"
echo ""

echo "--- watch-queue ---"
npx tsx "$PROJECT_DIR/tests/watch-queue.test.ts"
echo ""

echo "--- workspace ---"
npx tsx "$PROJECT_DIR/tests/workspace.test.ts"
echo ""

echo "--- rediscover-teams ---"
npx tsx "$PROJECT_DIR/tests/rediscover-teams.test.ts"
echo ""

echo "--- commit-message ---"
npx tsx "$PROJECT_DIR/tests/commit-message.test.ts"
echo ""

echo "--- checkpoint-commit ---"
npx tsx "$PROJECT_DIR/tests/checkpoint-commit.test.ts"
echo ""

echo "=== All unit tests passed ==="
