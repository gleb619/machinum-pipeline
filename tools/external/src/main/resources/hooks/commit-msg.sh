#!/usr/bin/env bash

commit_msg_file="$1"
commit_msg="$(head -n1 "$commit_msg_file")"

allowed_pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?(!)?: .+$'

if [[ ! "$commit_msg" =~ $allowed_pattern ]]; then
  cat >&2 <<'EOF'
ERROR: Invalid commit message format.

Expected format:
  <type>(<scope>): <subject>
  or
  <type>!: <subject>

Allowed types:
  feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

Example:
  feat(auth): add jwt authentication support
  fix!: resolve memory leak issue
EOF
  exit 1
fi

# Run markdown line validation after message check
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="$SCRIPT_DIR/scripts/validate-md-lines.js"

if [ -f "$NODE_SCRIPT" ]; then
  if command -v node &> /dev/null; then
    echo "Running markdown line validation..."
    node "$NODE_SCRIPT"
    if [ $? -ne 0 ]; then
      echo "ERROR: Markdown line validation failed"
      exit 1
    fi
    echo "Markdown line validation passed"
  else
    echo "WARNING: Node.js not found, skipping markdown validation"
  fi
else
  echo "WARNING: Markdown validation script not found at $NODE_SCRIPT"
fi