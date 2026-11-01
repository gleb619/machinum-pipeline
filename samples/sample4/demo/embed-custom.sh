#!/usr/bin/env bash
# Embedded store protected by a real (here: fake-demo) password read from MT_EMBED_PASSWORD_FILE.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

export MT_EMBED_PATH="$DEMO_DIR/secrets-custom.embed.json"
export MT_EMBED_PASSWORD_FILE="$DEMO_DIR/embed.pass"
rm -f "$MT_EMBED_PATH"
(umask 077 && echo 'demo-password-NOT-REAL' >"$MT_EMBED_PASSWORD_FILE")

"$MT" vault embed-add demo-embed-custom --secret "sk-demo-FAKE-custom-0000"

export MT_VAULT=./vault.embed-custom.json
export MT_DEMO_VAULT_REF=vault://demo-embed-custom
run_demo
