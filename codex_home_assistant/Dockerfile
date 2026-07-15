# syntax=docker/dockerfile:1.7
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24
FROM ${BUILD_FROM}

ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=0.4.0
ARG TARGETARCH
ARG CODEX_VERSION=0.144.1
ARG CODEX_SHA256=84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ARG WS_VERSION=8.18.3

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY playwright/package.json playwright/package-lock.json /usr/local/lib/codex-ha/playwright/

RUN apk add --no-cache \
      bash \
      ca-certificates \
      chromium-headless-shell \
      coreutils \
      curl \
      font-noto-cjk \
      font-noto-emoji \
      git \
      jq \
      less \
      nano \
      nginx \
      nodejs \
      openssh \
      ripgrep \
      shadow \
      sqlite \
      tmux \
      ttyd \
      yamllint \
      yq \
    && apk add --no-cache --virtual .playwright-build npm \
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
    && [[ "${codex_version_output}" == "codex-cli ${CODEX_VERSION}" ]] \
    && [[ "$(node -p "require('/usr/local/lib/codex-ha/playwright/package.json').dependencies['@playwright/mcp']")" == "${PLAYWRIGHT_MCP_VERSION}" ]] \
    && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_cache=/tmp/npm-cache \
      npm ci --prefix /usr/local/lib/codex-ha/playwright \
        --omit=dev --ignore-scripts --no-audit --no-fund \
    && [[ "$(node -p "require('/usr/local/lib/codex-ha/playwright/node_modules/@playwright/mcp/package.json').version")" == "${PLAYWRIGHT_MCP_VERSION}" ]] \
    && [[ "$(node -p "require('/usr/local/lib/codex-ha/playwright/node_modules/ws/package.json').version")" == "${WS_VERSION}" ]] \
    && node -e "require('/usr/local/lib/codex-ha/playwright/node_modules/playwright-core')" \
    && node --input-type=module -e "const ws = await import('/usr/local/lib/codex-ha/playwright/node_modules/ws/wrapper.mjs'); if (typeof ws.default !== 'function') process.exit(1)" \
    && node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('CREATE VIRTUAL TABLE smoke USING fts5(value)'); db.close()" \
    && chromium-headless-shell --version \
    && rm -rf /tmp/npm-cache \
    && apk del .playwright-build

COPY rootfs /

RUN printf '%s\n' "${BUILD_VERSION}" > /usr/local/share/codex-ha/app-version \
    && chmod 0755 \
      /etc/s6-overlay/s6-rc.d/codex-ha-init/run \
      /etc/s6-overlay/s6-rc.d/ha-memoryd/run \
      /etc/s6-overlay/s6-rc.d/ingress/finish \
      /etc/s6-overlay/s6-rc.d/ingress/run \
      /etc/s6-overlay/s6-rc.d/sshd/finish \
      /etc/s6-overlay/s6-rc.d/sshd/run \
      /etc/s6-overlay/s6-rc.d/ttyd/finish \
      /etc/s6-overlay/s6-rc.d/ttyd/run \
      /usr/local/bin/* \
      /usr/local/lib/codex-ha/api-client.sh \
    && chmod 0644 \
      /etc/codex/config.toml \
      /usr/local/lib/codex-ha/browser-approval.sh \
      /usr/local/share/codex-ha/AGENTS.md \
      /usr/local/share/codex-ha/browser-auth-check.mjs \
      /usr/local/share/codex-ha/browser-user-admin.mjs \
      /usr/local/share/codex-ha/ha-memory-core.mjs \
      /usr/local/share/codex-ha/ha-memory-ha-client.mjs \
      /usr/local/share/codex-ha/ha-memory-mcp.mjs \
      /usr/local/share/codex-ha/ha-memory.mjs \
      /usr/local/share/codex-ha/playwright-init-page.ts \
      /usr/local/share/codex-ha/playwright-mcp-proxy.mjs \
      /usr/local/share/codex-ha/playwright-mcp.json \
      /usr/local/share/codex-ha/user-files-update.mjs \
      /usr/local/share/codex-ha/app-version

RUN install -d -m 0700 /data/home /data/codex \
    && codex_version_output="$(codex --version)" \
    && [[ "${codex_version_output}" == "codex-cli ${CODEX_VERSION}" ]]

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="Home Assistant App: Codex for Home Assistant" \
  org.opencontainers.image.description="Codex CLI, Playwright browser, Ingress terminal, and public-key SSH for Home Assistant" \
  org.opencontainers.image.source="https://github.com/Kanu-Coffee/codex-for-home-assistant" \
  org.opencontainers.image.licenses="Apache-2.0"
