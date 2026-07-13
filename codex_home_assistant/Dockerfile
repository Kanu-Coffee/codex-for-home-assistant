# syntax=docker/dockerfile:1.7
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24
FROM ${BUILD_FROM}

ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=0.1.1-dev
ARG TARGETARCH
ARG CODEX_VERSION=0.144.1
ARG CODEX_SHA256=84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache \
      bash \
      ca-certificates \
      coreutils \
      curl \
      git \
      jq \
      less \
      nano \
      nginx \
      openssh \
      ripgrep \
      shadow \
      sqlite \
      tmux \
      ttyd \
      yamllint \
      yq \
    && resolved_arch="${TARGETARCH:-${BUILD_ARCH}}" \
    && if [[ "${resolved_arch}" != "amd64" ]]; then \
      echo "Unsupported architecture: ${resolved_arch}; this MVP supports amd64 only" >&2; \
      exit 1; \
    fi \
    && codex_archive="codex-x86_64-unknown-linux-musl.tar.gz" \
    && curl --fail --show-error --silent --location \
      --output "/tmp/${codex_archive}" \
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${codex_archive}" \
    && printf '%s  %s\n' "${CODEX_SHA256}" "/tmp/${codex_archive}" | sha256sum --check --strict - \
    && tar --extract --gzip --file "/tmp/${codex_archive}" --directory /tmp \
    && install -d -m 0755 /usr/local/libexec \
    && install -m 0755 /tmp/codex-x86_64-unknown-linux-musl /usr/local/libexec/codex-real \
    && rm -f "/tmp/${codex_archive}" /tmp/codex-x86_64-unknown-linux-musl \
    && codex_version_output="$(/usr/local/libexec/codex-real --version)" \
    && [[ "${codex_version_output}" == "codex-cli ${CODEX_VERSION}" ]]

COPY rootfs /

RUN chmod 0755 \
      /etc/s6-overlay/s6-rc.d/codex-ha-init/run \
      /etc/s6-overlay/s6-rc.d/ingress/finish \
      /etc/s6-overlay/s6-rc.d/ingress/run \
      /etc/s6-overlay/s6-rc.d/sshd/finish \
      /etc/s6-overlay/s6-rc.d/sshd/run \
      /etc/s6-overlay/s6-rc.d/ttyd/finish \
      /etc/s6-overlay/s6-rc.d/ttyd/run \
      /usr/local/bin/* \
      /usr/local/lib/codex-ha/api-client.sh

RUN install -d -m 0700 /data/home /data/codex \
    && codex_version_output="$(codex --version)" \
    && [[ "${codex_version_output}" == "codex-cli ${CODEX_VERSION}" ]]

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="Home Assistant App: Codex for Home Assistant" \
  org.opencontainers.image.description="Codex CLI, Ingress terminal, and public-key SSH for Home Assistant" \
  org.opencontainers.image.source="https://github.com/Kanu-Coffee/codex-for-home-assistant" \
  org.opencontainers.image.licenses="Apache-2.0"
