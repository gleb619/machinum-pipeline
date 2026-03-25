#!/usr/bin/env bash
# Transformer: Trim whitespace from text
# Reads JSON from stdin, transforms, writes to stdout

if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed" >&2
    exit 1
fi

# Read JSON, trim text field, output JSON
jq '.text |= gsub("^\\s+|\\s+$"; "")'
