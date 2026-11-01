#!/bin/sh
# mt-entrypoint: first-run master key for the machinum-pipeline image, then exec `mt`.
# - Generates $MT_HOME/master.key (mode 0600) when no key source is configured. The key is
#   never baked into the image and never printed (mt prints only its path).
# - Skipped when MT_EMBED_PASSWORD(_FILE) is set, a project/user key exists, MT_NO_AUTO_KEY is set,
#   or the command does not touch secrets (--help, --version, skill, init, vault master-key ...).
set -eu

MT_HOME="${MT_HOME:-/home/mt/.mt}"
export MT_HOME

case "${1:-}" in
  "" | -h | --help | help | -V | --version | skill | init) exec mt "$@" ;;
  vault) [ "${2:-}" = "master-key" ] && exec mt "$@" ;;
esac

if [ -z "${MT_NO_AUTO_KEY:-}" ] &&
  [ -z "${MT_EMBED_PASSWORD:-}" ] && [ -z "${MT_EMBED_PASSWORD_FILE:-}" ] &&
  [ ! -e "${MT_HOME}/master.key" ] && [ ! -e "${PWD}/.mt/master.key" ]; then
  if mkdir -p "${MT_HOME}" 2>/dev/null; then
    mt vault master-key generate --user >&2 ||
      echo "mt-entrypoint: warning: master key generation failed; secrets fall back to the public default" >&2
  else
    echo "mt-entrypoint: warning: ${MT_HOME} not writable; mount a volume or set MT_EMBED_PASSWORD_FILE" >&2
  fi
fi

exec mt "$@"
