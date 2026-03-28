#!/bin/bash
# Transforms JSON input: adds processed flag and timestamp
input=$(cat)
echo "$input" | jq '. + {"processed": true, "timestamp": "'$(date -Iseconds)'"}'
