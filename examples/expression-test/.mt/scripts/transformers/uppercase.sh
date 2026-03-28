#!/usr/bin/env bash
# Transformer: Convert text to uppercase using shell
# Reads JSON from stdin, transforms, writes to stdout

# Check if jq is available
if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed" >&2
    exit 1
fi

# Read JSON, transform text field, output JSON
jq '.text |= ascii_upcase'
