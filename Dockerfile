# syntax=docker/dockerfile:1.7
#
# machinum-pipeline (`mt`) image. The artifact is the Bun single-file binary, so the image just
# installs that binary; no Node, no node_modules.
#
# Registry decision: `mt` (packages/mt) is an UNSCOPED npm name, and GitHub Packages' npm
# registry only serves scoped packages, so an npm install mode is not offered. Source of the
# binary is GitHub Releases (asset mt-linux-<x64|arm64> + SHA256SUMS, sha256-verified).
#
# Build (BuildKit required; unused source stages are skipped):
#   docker build --build-arg MT_VERSION=0.1.0 -t mt .                      # from a GitHub release
#   pnpm build:bin && docker build --build-arg MT_SOURCE=local -t mt .     # from packages/mt/dist/bin/mt (glibc, host arch)
# Run:
#   docker run --rm -v "$PWD":/work -v "$HOME/.mt":/home/mt/.mt mt run ./pipelines/p.ts
ARG MT_SOURCE=release

# ---- binary source: GitHub release ------------------------------------------------------------
FROM debian:bookworm-slim AS bin-release
ARG MT_VERSION=""
ARG MT_RELEASE_BASE_URL="https://github.com/gleb619/machinum-pipeline/releases/download"
ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /out
RUN test -n "${MT_VERSION}" || { echo "set --build-arg MT_VERSION=<x.y.z> (or MT_SOURCE=local)" >&2; exit 1; }; \
    case "${TARGETARCH:-amd64}" in \
      amd64) asset=mt-linux-x64 ;; \
      arm64) asset=mt-linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="${MT_RELEASE_BASE_URL}/v${MT_VERSION#v}"; \
    curl -fsSL --retry 3 -o "${asset}" "${base}/${asset}"; \
    curl -fsSL --retry 3 -o SHA256SUMS "${base}/SHA256SUMS"; \
    grep " \*\?${asset}\$" SHA256SUMS | sed "s| \*\?${asset}\$| ${asset}|" | sha256sum -c -; \
    install -m 0755 "${asset}" /out/mt

# ---- binary source: local build (hermetic tests / CI) -----------------------------------------
FROM debian:bookworm-slim AS bin-local
COPY packages/mt/dist/bin/mt /out/mt
RUN chmod 0755 /out/mt

# hadolint ignore=DL3006
FROM bin-${MT_SOURCE} AS bin

# ---- runtime ----------------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
ARG MT_VERSION=""
ARG VCS_REF=""
LABEL org.opencontainers.image.title="machinum-pipeline" \
      org.opencontainers.image.description="mt: composable, checkpointable ETL engine for long-form text" \
      org.opencontainers.image.source="https://github.com/gleb619/machinum-pipeline" \
      org.opencontainers.image.url="https://github.com/gleb619/machinum-pipeline" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${MT_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin mt \
    && mkdir -p /work /home/mt/.mt \
    && chown mt:mt /work /home/mt/.mt \
    && chmod 0777 /work /home/mt/.mt

COPY --from=bin /out/mt /usr/local/bin/mt
COPY docker/entrypoint.sh /usr/local/bin/mt-entrypoint
RUN chmod 0755 /usr/local/bin/mt-entrypoint

# MT_HOME holds master.key, the embedded secret store and the user vault. NEVER bake a key in:
# mount a volume (or MT_EMBED_PASSWORD_FILE as a secret); the entrypoint generates a key on first run.
ENV MT_HOME=/home/mt/.mt
USER 1000:1000
WORKDIR /work
VOLUME ["/work", "/home/mt/.mt"]
# No HEALTHCHECK: the image is a CLI that exits; `mt serve` / `mt router` users add their own probe.
ENTRYPOINT ["mt-entrypoint"]
CMD ["--help"]
