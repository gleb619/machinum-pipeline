# Shared helpers for the secret-backend demos. Sourced, not executed.
# Everything generated lands in samples/sample4/.demo/ (gitignored). All secrets are FAKE.
SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="$SAMPLE_DIR/.demo"
MT="$SAMPLE_DIR/node_modules/.bin/mt"
cd "$SAMPLE_DIR"
mkdir -p "$DEMO_DIR"

# Never inherit the caller's secret-backend config: the demo must behave the same everywhere.
unset MT_EMBED_PASSWORD MT_EMBED_PASSWORD_FILE MT_EMBED_PATH \
  MT_KEEPASS_PASSWORD MT_KEEPASS_PASSWORD_FILE MT_KEEPASS_KEY_FILE MT_KEEPASS_PATH \
  MT_EMBED MT_KEEPASS MT_VLT MT_DEMO_VAULT_REF

# Print and stop WITHOUT failing: an unavailable backend is not a test/CI failure.
skip() {
  echo "[demo] SKIPPED: $*"
  exit 0
}

# Run the pipeline step that resolves the vault ref. Needs MT_VAULT + MT_DEMO_VAULT_REF.
run_demo() {
  rm -f "$DEMO_DIR/result.jsonl"
  echo '{"item":{"demo":true}}' >"$DEMO_DIR/input.jsonl"
  NODE_OPTIONS='--import tsx' "$MT" run ./pipelines/secrets-demo.ts
  echo "[demo] OK, result written to .demo/result.jsonl (entry + key length only)"
}
