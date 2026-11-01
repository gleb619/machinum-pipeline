#!/usr/bin/env bash
# vlt backend. vlt's `create`/`login` are interactive-only, so this script does NOT seed it:
# it checks the prerequisites and runs the step only when they hold, else prints how to set up.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

status="$("$MT" vault vlt-status 2>&1 || true)"
echo "$status"

if echo "$status" | grep -q 'vlt: not found'; then
  skip "vlt binary not found. Run: pnpm exec mt vault vlt-install"
fi
VLT="$(echo "$status" | sed -n 's/^vlt: found at //p')"
if ! echo "$status" | grep -q 'session: active'; then
  skip "vlt session locked or no vault. One-time setup (interactive): $VLT create; $VLT login"
fi
if ! timeout 15 "$VLT" show demo_key --stdout -P </dev/null >/dev/null 2>&1; then
  skip "vlt secret demo_key missing. Add a FAKE one: echo 'sk-demo-FAKE-vlt-0000' | $VLT save --name demo_key"
fi

export MT_VAULT=./vault.vlt.json
export MT_DEMO_VAULT_REF=vault://demo-vlt
run_demo
