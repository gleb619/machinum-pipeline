# Rendering logs with `leaf`

`leaf` is a terminal Markdown renderer (Rust, by RivoLink): rich rendering (syntax highlighting,
LaTeX, Mermaid), vim-like navigation, live watch mode, external editor via `Ctrl+E`.

Because `mt` log output is **markdown-compatible** by default (plain text mode escapes markdown
specials — see `packages/cli/src/utils/logger.ts`), you can pipe run output or `run.log` files
straight into `leaf` for a scrollable, highlighted view.

> Do not pipe `--json|--jsonl` output into `leaf` — that mode is JSONL for machines, not markdown.

Two ways to use it: **native install** or **Docker**.

## Way 1 — native `leaf`

### Install (pick your OS)

```bash
# Any OS with Rust toolchain (https://rustup.rs)
cargo install leaf-markdown-viewer

# Arch Linux (AUR)
yay -S leaf-markdown-viewer

# macOS / Linux (Homebrew)
brew install leaf
```

Compile-from-source prerequisites on Debian/Ubuntu if the build fails:
`sudo apt install build-essential pkg-config libssl-dev`.

### Config

Config path: `~/.config/leaf/leaf.toml` (Linux), `~/Library/Application Support/leaf/leaf.toml`
(macOS). Sample:

```toml
# Dark theme — others: "Ocean", "Solarized-Dark", ...
theme = "Solarized-Dark"

# External editor for Ctrl+E — change to "vim", "code", ...
editor = "nvim"

[render]
latex = true     # LaTeX math rendering
mermaid = true   # Mermaid diagram rendering
```

### Usage with mt logs

```bash
# Render a run's log file
leaf .mt/runs/<runId>/run.log

# Live-watch a running pipeline's log — auto-reloads as mt appends
leaf -w .mt/runs/<runId>/run.log

# Pipe live output
mt run ./pipeline.ts 2>&1 | leaf -

# Editor workflow: open log, Ctrl+E to edit in $EDITOR, save → leaf refreshes
```

Keybindings: `j`/`k` scroll, `g`/`G` top/bottom, `/` search, `n` next match, `Ctrl+E` edit, `q` quit.

## Way 2 — Docker

No official image exists; build a minimal multi-stage one:

```dockerfile
# Stage 1: build
FROM rust:alpine AS builder
RUN apk add --no-cache musl-dev
RUN cargo install leaf-markdown-viewer

# Stage 2: minimal runtime
FROM alpine:latest
RUN apk add --no-cache libgcc
COPY --from=builder /usr/local/cargo/bin/leaf /usr/local/bin/leaf
WORKDIR /workspace
ENTRYPOINT ["leaf"]
```

### Build & run

```bash
docker build -t leaf-renderer .

# Pipe a log file in (stdin) — -i keeps STDIN open, --rm removes the container
cat .mt/runs/<runId>/run.log | docker run --rm -i leaf-renderer -

# Pipe live mt output
mt run ./pipeline.ts 2>&1 | docker run --rm -i leaf-renderer -

# Or mount the project and pass a path
docker run --rm -it -v "$(pwd):/workspace" leaf-renderer .mt/runs/<runId>/run.log
```

## Handling ANSI-rendered output

```bash
# Scroll rendered output in a pager (interpret ANSI colors)
cat .mt/runs/<runId>/run.log | docker run --rm -i leaf-renderer - | less -R

# Save raw ANSI output to a file
mt run ./pipeline.ts 2>&1 | docker run --rm -i leaf-renderer - > rendered.log

# Strip ANSI codes → plain text
mt run ./pipeline.ts 2>&1 | docker run --rm -i leaf-renderer - \
  | sed 's/\x1b\[[0-9;]*m//g' > plain.txt
```

## Troubleshooting

- **No colors inside Docker pipe** — `-i` without `-t` allocates no TTY, so tools often disable
  color. Add `-t` (`docker run --rm -it ...`) or force color via `leaf --color=always` /
  `FORCE_COLOR=1` (check `leaf --help` for the exact flag).
- **Cargo build fails** — missing C toolchain: install `build-essential pkg-config libssl-dev`
  (Debian/Ubuntu) or `musl-dev` (Alpine).
- **Weird glyphs / broken themes** — use a terminal with truecolor + Nerd Font support
  (kitty, alacritty, wezterm, modern Windows Terminal).
