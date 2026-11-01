#!/usr/bin/env bash
# Embedded encrypted store, zero config: built-in default password (public obfuscation only).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

export MT_EMBED_PATH="$DEMO_DIR/secrets.embed.json" # keep the store out of ~/.mt
rm -f "$MT_EMBED_PATH"

"$MT" vault embed-add demo-embed --secret "sk-demo-FAKE-embed-0000"

# Keyring: add a 2nd encryption key (kid k2), store a 2nd secret under it, list (no key material).
"$MT" vault embed-keyring generate --kid k2 --note "demo second key" 2>/dev/null
"$MT" vault embed-add demo-embed-k2 --kid k2 --secret "sk-demo-FAKE-embed-k2-0000" 2>/dev/null
"$MT" vault embed-keyring list 2>/dev/null

export MT_VAULT=./vault.embed.json
export MT_DEMO_VAULT_REF=vault://demo-embed
run_demo
