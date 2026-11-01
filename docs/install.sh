#!/bin/sh
# machinum-pipeline installer (marker: machinum-pipeline install.sh)
#
#   curl -fsSL https://raw.githubusercontent.com/gleb619/machinum-pipeline/main/docs/install.sh | sh -s -- --help
#
# Installs the `mt` CLI either as the released single-file binary (default), as a thin wrapper
# around the Docker image (--docker), or by building from source (--from-source).
# POSIX sh, idempotent, never uses sudo, never prints a master key.
#
# Test-only hook (not for users): MT_INSTALL_FROM_LOCAL=<path-to-mt-binary> copies that file
# instead of downloading a release (no checksum step). MT_INSTALL_SKIP_PULL=1 skips `docker pull`
# in --docker mode (image already present locally).
set -eu

REPO="gleb619/machinum-pipeline"
REPO_HTTPS="https://github.com/${REPO}.git"
IMAGE_REPO="ghcr.io/${REPO}"
MARKER="machinum-pipeline install.sh"

MODE="binary"
VERSION=""
NAME="mt"
BIN_DIR="${MT_INSTALL_DIR:-${HOME:-.}/.local/bin}"
USER_KEY=0
YES=0
DRY=0
FORCE=0
UNINSTALL=0
SRC_DIR="${MT_SOURCE_DIR:-${HOME:-.}/.local/share/machinum-pipeline}"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Usage: install.sh [mode] [options]

Modes (default: --no-docker, the released binary):
  --no-docker       download the released binary for this OS/arch, verify sha256, install
  --docker          install a wrapper that runs the ghcr.io Docker image
  --from-source     git clone + corepack/pnpm + `pnpm build:bin` (needs git, node>=20, bun)

Options:
  --version <v>     release to install, e.g. 0.1.0 or v0.1.0 (default: latest GitHub release)
  --prefix <dir>    install into <dir>/bin (default: $MT_INSTALL_DIR or ~/.local/bin)
  --name <name>     installed command name (default: mt; use mt-cli to avoid /usr/bin/mt)
  --user-master-key after install run `mt vault master-key generate --user`
                    (skipped if a key or MT_EMBED_PASSWORD(_FILE) already exists; never printed)
  --force           reinstall even if the same version is already installed
  --yes             do not ask for confirmation (required without a terminal)
  --dry-run         print what would happen, change nothing
  --uninstall       remove the installed command (never touches ~/.mt or any master key)
  --help            this text

Examples:
  curl -fsSL https://raw.githubusercontent.com/gleb619/machinum-pipeline/main/docs/install.sh | sh -s -- --dry-run
  curl -fsSL https://raw.githubusercontent.com/gleb619/machinum-pipeline/main/docs/install.sh | sh -s -- --docker --yes
  sh install.sh --name mt-cli --user-master-key

Env: MT_INSTALL_DIR (bin dir), MT_SOURCE_DIR (--from-source checkout), MT_HOME (state dir, default ~/.mt)
EOF
}

# ---- args -------------------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE="docker" ;;
    --no-docker) MODE="binary" ;;
    --from-source) MODE="source" ;;
    --version)
      [ $# -ge 2 ] || die "--version needs a value"
      VERSION="$2"
      shift
      ;;
    --prefix)
      [ $# -ge 2 ] || die "--prefix needs a value"
      BIN_DIR="$2/bin"
      shift
      ;;
    --name)
      [ $# -ge 2 ] || die "--name needs a value"
      NAME="$2"
      shift
      ;;
    --user-master-key) USER_KEY=1 ;;
    --force) FORCE=1 ;;
    --yes | -y) YES=1 ;;
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

case "$NAME" in
  */* | "" | .*) die "--name must be a plain command name" ;;
esac

TARGET="${BIN_DIR}/${NAME}"
TMP=""
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

# ---- helpers ----------------------------------------------------------------------------------
mt_home() { printf '%s' "${MT_HOME:-${HOME:-.}/.mt}"; }

download() { # url dest
  if have curl; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif have wget; then
    wget -q -O "$2" "$1"
  else
    die "need curl or wget"
  fi
}

fetch_text() { # url -> stdout
  if have curl; then
    curl -fsSL --retry 3 "$1"
  elif have wget; then
    wget -q -O - "$1"
  else
    die "need curl or wget"
  fi
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "need sha256sum or shasum to verify the download"
  fi
}

detect_target() { # -> linux-x64 | linux-x64-musl | linux-arm64 | linux-arm64-musl | darwin-x64 | darwin-arm64
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) die "unsupported architecture: $arch" ;;
  esac
  case "$os" in
    Linux)
      musl=""
      if [ -f /etc/alpine-release ] || { have ldd && ldd --version 2>&1 | grep -qi musl; }; then
        musl="-musl"
      fi
      printf 'linux-%s%s' "$arch" "$musl"
      ;;
    Darwin) printf 'darwin-%s' "$arch" ;;
    *) die "unsupported OS: $os (Windows: use --docker under WSL or download mt-windows-x64.exe manually)" ;;
  esac
}

resolve_version() { # sets VERSION to a bare number like 0.1.0, or "latest" for docker fallback
  if [ -n "$VERSION" ]; then
    VERSION="${VERSION#v}"
    return 0
  fi
  if [ -n "${MT_INSTALL_FROM_LOCAL:-}" ]; then
    VERSION="local"
    return 0
  fi
  if [ "$DRY" = 1 ] && [ "$MODE" != "source" ]; then
    VERSION="latest"
    return 0
  fi
  tag="$(fetch_text "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)" || tag=""
  if [ -n "$tag" ]; then
    VERSION="${tag#v}"
    return 0
  fi
  if [ "$MODE" = "docker" ]; then
    warn "could not query the latest release; using image tag 'latest'"
    VERSION="latest"
    return 0
  fi
  die "could not determine the latest release (no release published yet, or rate limited). Pass --version <v>, or use --from-source."
}

confirm() {
  [ "$YES" = 1 ] && return 0
  [ "$DRY" = 1 ] && return 0
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf 'Proceed? [y/N] ' >/dev/tty
    read -r ans </dev/tty || ans=""
    case "$ans" in y | Y | yes | YES) return 0 ;; esac
    die "aborted"
  fi
  die "no terminal to confirm on; re-run with --yes"
}

is_ours() { # file -> 0 if it is a wrapper we wrote or an mt binary
  [ -f "$1" ] || return 1
  if [ -x "$1" ] && [ "$(wc -c <"$1")" -lt 65536 ] && grep -q "$MARKER" "$1" 2>/dev/null; then
    return 0
  fi
  out="$("$1" --version 2>/dev/null | head -n 1)" || out=""
  case "$out" in "mt "*) return 0 ;; esac
  return 1
}

installed_version() { "$TARGET" --version 2>/dev/null | head -n 1 | sed 's/^mt //'; }

path_hints() {
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) warn "${BIN_DIR} is not on PATH. Add: export PATH=\"${BIN_DIR}:\$PATH\"" ;;
  esac
  if [ "$NAME" = "mt" ] && [ "$(uname -s)" = "Linux" ]; then
    first="$(command -v mt 2>/dev/null || true)"
    if [ -n "$first" ] && [ "$first" != "$TARGET" ]; then
      warn "'mt' on PATH resolves to ${first} (Linux tape tool), not this install."
      warn "Re-run with --name mt-cli, or put ${BIN_DIR} first on PATH."
    elif [ -z "$first" ] && [ -x /usr/bin/mt ]; then
      warn "/usr/bin/mt (tape tool) exists; make sure ${BIN_DIR} precedes /usr/bin on PATH, or use --name mt-cli."
    fi
  fi
}

place() { # src -> TARGET, atomically, mode 755
  mkdir -p "$BIN_DIR"
  [ -w "$BIN_DIR" ] || die "${BIN_DIR} is not writable (this script never uses sudo; pick another --prefix)"
  cp "$1" "${TARGET}.new.$$"
  chmod 755 "${TARGET}.new.$$"
  mv -f "${TARGET}.new.$$" "$TARGET"
}

# ---- uninstall --------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "Plan: remove ${TARGET}. ~/.mt (vault, embedded store, master.key) is NOT touched."
  [ -e "$TARGET" ] || {
    say "nothing to remove: ${TARGET} does not exist"
    exit 0
  }
  is_ours "$TARGET" || die "${TARGET} does not look like an mt install; refusing to delete it"
  confirm
  if [ "$DRY" = 1 ]; then
    say "[dry-run] rm ${TARGET}"
  else
    rm -f "$TARGET"
    say "removed ${TARGET}"
  fi
  say "Back-up reminder: keep $(mt_home)/master.key if you still have embedded secrets."
  exit 0
fi

# ---- plan -------------------------------------------------------------------------------------
resolve_version
case "$MODE" in
  binary)
    PLATFORM="$(detect_target)"
    ASSET="mt-${PLATFORM}"
    if [ "${VERSION}" = "latest" ]; then
      BASE="https://github.com/${REPO}/releases/latest/download"
    else
      BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
    fi
    if [ -n "${MT_INSTALL_FROM_LOCAL:-}" ]; then
      say "Plan: copy local binary ${MT_INSTALL_FROM_LOCAL} -> ${TARGET} (test hook, no checksum)"
    else
      say "Plan: download ${BASE}/${ASSET}"
      say "      verify sha256 against ${BASE}/SHA256SUMS"
      say "      install -> ${TARGET}"
    fi
    ;;
  docker)
    IMAGE="${IMAGE_REPO}:${VERSION}"
    say "Plan: docker pull ${IMAGE}"
    say "      write wrapper -> ${TARGET} (docker run --rm; mounts \$PWD at /work and $(mt_home) at /home/mt/.mt)"
    ;;
  source)
    say "Plan: git clone ${REPO_HTTPS} -> ${SRC_DIR}${VERSION:+ (ref v${VERSION})}"
    say "      corepack pnpm install + pnpm build:bin (needs git, node>=20, corepack, bun)"
    say "      install -> ${TARGET}"
    ;;
esac
[ "$USER_KEY" = 1 ] && say "      then: ${NAME} vault master-key generate --user (only if no key exists)"
say "      (no sudo is used)"

if [ "$DRY" = 1 ]; then
  say "[dry-run] nothing changed."
  exit 0
fi
confirm

if [ -e "$TARGET" ] && ! is_ours "$TARGET"; then
  die "${TARGET} exists and is not an mt install; use --name or --prefix"
fi

# ---- install ----------------------------------------------------------------------------------
TMP="$(mktemp -d)"

case "$MODE" in
  binary)
    if [ -n "${MT_INSTALL_FROM_LOCAL:-}" ]; then
      [ -x "$MT_INSTALL_FROM_LOCAL" ] || die "MT_INSTALL_FROM_LOCAL is not an executable file"
      place "$MT_INSTALL_FROM_LOCAL"
    else
      if [ "$FORCE" = 0 ] && [ -x "$TARGET" ] && [ "$(installed_version)" = "$VERSION" ]; then
        say "mt ${VERSION} already installed at ${TARGET} (use --force to reinstall)"
      else
        download "${BASE}/${ASSET}" "${TMP}/${ASSET}" ||
          die "download failed: ${BASE}/${ASSET} (is v${VERSION} released for ${PLATFORM}?)"
        download "${BASE}/SHA256SUMS" "${TMP}/SHA256SUMS" || die "download failed: ${BASE}/SHA256SUMS"
        want="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1; exit }' "${TMP}/SHA256SUMS")"
        [ -n "$want" ] || die "no checksum for ${ASSET} in SHA256SUMS"
        got="$(sha256_of "${TMP}/${ASSET}")"
        [ "$want" = "$got" ] || die "sha256 mismatch for ${ASSET}: expected ${want}, got ${got}"
        say "sha256 ok (${got})"
        place "${TMP}/${ASSET}"
      fi
    fi
    ;;
  docker)
    have docker || die "docker not found on PATH"
    if [ -z "${MT_INSTALL_SKIP_PULL:-}" ]; then
      docker pull "$IMAGE" || die "docker pull ${IMAGE} failed (image published? ghcr package public?)"
    fi
    mkdir -p "$BIN_DIR"
    [ -w "$BIN_DIR" ] || die "${BIN_DIR} is not writable (this script never uses sudo)"
    cat >"${TMP}/wrapper" <<EOF
#!/bin/sh
# ${MARKER} -- runs the machinum-pipeline Docker image as \`${NAME}\`.
# Mounts: current dir -> /work (project + .mt/), \${MT_HOME:-~/.mt} -> /home/mt/.mt (master.key, vault, embed store).
# Extra docker flags: MT_DOCKER_ARGS (e.g. "-p 3000:3000" for \`mt serve\`); image override: MT_IMAGE.
set -eu
home="\${MT_HOME:-\$HOME/.mt}"
mkdir -p "\$home"
tty=""
if [ -t 0 ] && [ -t 1 ]; then tty="-it"; fi
# shellcheck disable=SC2086
exec docker run --rm \$tty --user "\$(id -u):\$(id -g)" \\
  -v "\$PWD":/work -w /work \\
  -v "\$home":/home/mt/.mt \\
  -e OPENROUTER_API_KEYS -e MT_OLLAMA_URL -e MT_ROUTER_URL -e MT_LOG_LEVEL -e MT_DEBUG \\
  -e MT_EMBED_PASSWORD \\
  \${MT_DOCKER_ARGS:-} \\
  "\${MT_IMAGE:-${IMAGE}}" "\$@"
EOF
    place "${TMP}/wrapper"
    ;;
  source)
    for tool in git node corepack bun; do have "$tool" || die "--from-source needs '${tool}' on PATH"; done
    if [ -d "${SRC_DIR}/.git" ]; then
      git -C "$SRC_DIR" fetch --tags --quiet
    else
      mkdir -p "$(dirname "$SRC_DIR")"
      git clone --quiet "$REPO_HTTPS" "$SRC_DIR"
    fi
    if [ -n "$VERSION" ]; then
      git -C "$SRC_DIR" checkout --quiet "v${VERSION}" || die "tag v${VERSION} not found"
    else
      git -C "$SRC_DIR" pull --ff-only --quiet || warn "could not fast-forward ${SRC_DIR}; building what is there"
    fi
    # pnpm shim in a temp dir: `corepack enable` into the node prefix may need root.
    mkdir -p "${TMP}/shim"
    corepack enable --install-directory "${TMP}/shim"
    (
      cd "$SRC_DIR"
      PATH="${TMP}/shim:${PATH}"
      export PATH
      pnpm install --frozen-lockfile
      pnpm build:bin
    )
    [ -x "${SRC_DIR}/packages/mt/dist/bin/mt" ] || die "build produced no binary"
    place "${SRC_DIR}/packages/mt/dist/bin/mt"
    ;;
esac

say "installed: ${TARGET}"
path_hints

# ---- master key -------------------------------------------------------------------------------
if [ "$USER_KEY" = 1 ]; then
  if [ -n "${MT_EMBED_PASSWORD:-}" ] || [ -n "${MT_EMBED_PASSWORD_FILE:-}" ]; then
    say "master key: MT_EMBED_PASSWORD(_FILE) is set; not generating one."
  elif [ -e "$(mt_home)/master.key" ]; then
    say "master key: $(mt_home)/master.key already exists; left untouched."
  else
    mkdir -p "$(mt_home)"
    if "$TARGET" vault master-key generate --user; then
      warn "BACK UP $(mt_home)/master.key. Losing it makes embedded secrets unrecoverable. Never commit it."
    else
      warn "master key generation failed; run '${NAME} vault master-key generate --user [--rekey]' yourself."
    fi
  fi
else
  say "tip: every installation should have its own master key: '${NAME} vault master-key generate --user'"
  say "     (or '${NAME} init' in a project). Back it up; never commit it."
fi
say "next: ${NAME} --help"
