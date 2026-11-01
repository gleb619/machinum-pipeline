#!/usr/bin/env bash
# KeePass .kdbx backend (pure JS, no external binary): creates a throw-away database.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

export MT_KEEPASS_PATH="$DEMO_DIR/demo.kdbx"
export MT_KEEPASS_PASSWORD_FILE="$DEMO_DIR/keepass.pass"
rm -f "$MT_KEEPASS_PATH"
(umask 077 && echo 'demo-master-NOT-REAL' >"$MT_KEEPASS_PASSWORD_FILE")

"$MT" vault keepass-init >/dev/null || skip "could not create the KeePass database (see error above)"
"$MT" vault keepass-add demo-key --secret "sk-demo-FAKE-keepass-0000" --group LLM/API \
  || skip "could not add the KeePass entry (see error above)"

export MT_VAULT=./vault.keepass.json
export MT_DEMO_VAULT_REF=vault://demo-keepass
run_demo
