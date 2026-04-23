#!/usr/bin/env bash
#
# Smoke test: creates a fixture repo, configures it to use my-pi as a
# package, and verifies the agent extension loads and the task queue
# operations work end-to-end.
#
# This solves the chicken/egg problem of testing an extension that
# manages the repo it's developed in.
#
# Usage: ./scripts/test-smoke.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MY_PI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Smoke Test ==="
echo "my-pi location: $MY_PI_DIR"
echo ""

# -----------------------------------------------------------------------
# 1. Create a temp fixture repo
# -----------------------------------------------------------------------
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

echo "--- Creating fixture repo at $FIXTURE_DIR ---"
cd "$FIXTURE_DIR"
git init -b main > /dev/null 2>&1
git commit --allow-empty -m "init" > /dev/null 2>&1

mkdir -p src
cat > src/app.ts << 'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
EOF
git add -A && git commit -m "add app.ts" > /dev/null 2>&1

# -----------------------------------------------------------------------
# 2. Configure fixture to use my-pi as a package
# -----------------------------------------------------------------------
echo "--- Configuring .pi/settings.json ---"
mkdir -p .pi
cat > .pi/settings.json << EOF
{
  "packages": ["$MY_PI_DIR"]
}
EOF
echo "  ✓ Fixture repo configured"

# -----------------------------------------------------------------------
# 3. Verify agent definitions are discoverable
# -----------------------------------------------------------------------
echo "--- Verifying agent definitions ---"
AGENTS_DIR="$MY_PI_DIR/agents"

AGENT_FILES=(
  roles/orchestrator.md
  roles/evaluator.md
  roles/code-reviewer.md
  workers/implementer.md
  workers/scout.md
  workers/researcher.md
  workers/tester.md
)
for file in "${AGENT_FILES[@]}"; do
  if [ ! -f "$AGENTS_DIR/$file" ]; then
    echo "FAIL: $file not found"
    exit 1
  fi
done
echo "  ✓ All agent definitions present (${#AGENT_FILES[@]} files)"

# -----------------------------------------------------------------------
# 4. Test task queue file operations from the project directory
# -----------------------------------------------------------------------
echo "--- Testing queue operations ---"

QUEUE_PATH="$FIXTURE_DIR/.team-smoke.json"
cd "$MY_PI_DIR"
QUEUE_PATH="$QUEUE_PATH" npx tsx tests/smoke-queue-ops.ts

# -----------------------------------------------------------------------
# 5. Verify queue file is valid JSON
# -----------------------------------------------------------------------
echo "--- Verifying queue file ---"
if ! python3 -m json.tool "$QUEUE_PATH" > /dev/null 2>&1; then
  echo "FAIL: Queue file is not valid JSON"
  exit 1
fi
echo "  ✓ Queue file is valid JSON"

# -----------------------------------------------------------------------
# 6. Check tmux is available (needed for team launch)
# -----------------------------------------------------------------------
echo "--- Checking tmux availability ---"
if command -v tmux &> /dev/null; then
  echo "  ✓ tmux found: $(tmux -V)"
else
  echo "  ⚠ tmux not found — team launch will not work"
fi

# -----------------------------------------------------------------------
# 7. Verify TypeScript compiles
# -----------------------------------------------------------------------
echo "--- Verifying TypeScript compilation ---"
cd "$MY_PI_DIR"
./node_modules/.bin/tsc --noEmit > /dev/null 2>&1
echo "  ✓ TypeScript compiles clean"

echo ""
echo "=== All smoke tests passed ==="
