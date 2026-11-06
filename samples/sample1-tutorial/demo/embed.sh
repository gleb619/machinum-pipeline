#!/usr/bin/env bash
# Embedded encrypted store, zero config: built-in default password (public obfuscation only).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

export MT_EMBED_PATH="$DEMO_DIR/secrets.embed.json" # keep the store out of ~/.mt
rm -f "$MT_EMBED_PATH" "$DEMO_DIR/result.jsonl"

"$MT" vault embed-add demo-embed --secret "sk-demo-FAKE-embed-0000"

export MT_VAULT=./vault.embed.json
export MT_DEMO_VAULT_REF=vault://demo-embed
NODE_OPTIONS='--import tsx' "$MT" run ./pipelines/pipe10-secrets.ts
echo "[demo] OK, result written to .demo/result.jsonl (entry + key length only)"
