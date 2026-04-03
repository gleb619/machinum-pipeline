#!/usr/bin/env bash

# Run markdown line validation
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && $(pwd)../.mt/scripts/validators)"
NODE_SCRIPT="$SCRIPT_DIR/validate-md-lines.js"

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