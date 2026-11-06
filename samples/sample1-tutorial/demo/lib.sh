# Shared helpers for the secret-backend demo. Sourced, not executed.
# Everything generated lands in samples/sample1-tutorial/.demo/ (gitignored). All secrets are FAKE.
SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="$SAMPLE_DIR/.demo"
MT="$SAMPLE_DIR/node_modules/.bin/mt"
cd "$SAMPLE_DIR"
mkdir -p "$DEMO_DIR"

# Never inherit the caller's secret-backend config: the demo must behave the same everywhere.
unset MT_EMBED_PASSWORD MT_EMBED_PASSWORD_FILE MT_EMBED_PATH \
  MT_KEEPASS_PASSWORD MT_KEEPASS_PASSWORD_FILE MT_KEEPASS_KEY_FILE MT_KEEPASS_PATH \
  MT_EMBED MT_KEEPASS MT_VLT MT_DEMO_VAULT_REF

echo '{"item":{"demo":true}}' >"$DEMO_DIR/input.jsonl"
