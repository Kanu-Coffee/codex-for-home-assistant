# syntax=docker/dockerfile:1.7
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24@sha256:94ff231402a5e7ad2a82e261ad5fa4ffae7d7bb095c3febb2edbdf309c9b6aca
FROM ${BUILD_FROM}

ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=0.7.0-dev.2
ARG TARGETARCH
ARG CODEX_VERSION=0.144.1
ARG CODEX_SHA256_AMD64=84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28
ARG CODEX_SHA256_AARCH64=b9f8ef5f98e46ced4dbbd3756a4223e3ee299a457ff488a3305bea455da8b5b8
ARG GH_VERSION=2.97.0
ARG GH_SHA256_AMD64=a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112
ARG GH_SHA256_AARCH64=73ea440ecad9c9e284429997ee6f93577bc6f7bc6fba357ef62c53ad8fb641a5
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ARG WS_VERSION=8.21.0

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN case "${BUILD_ARCH}:${TARGETARCH:-}" in \
      amd64:|amd64:amd64|aarch64:|aarch64:arm64) ;; \
      *) \
        printf '%s\n' \
          "Architecture mismatch or unsupported target: BUILD_ARCH=${BUILD_ARCH}, TARGETARCH=${TARGETARCH:-unset}; expected amd64:amd64 or aarch64:arm64" >&2; \
        exit 1; \
        ;; \
    esac

COPY playwright/package.json playwright/package-lock.json /usr/local/lib/codex-ha/playwright/

RUN apk upgrade --no-cache \
    && apk add --no-cache \
      bash \
      bubblewrap \
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
    && rm -f /usr/bin/tempio \
    && apk add --no-cache --virtual .playwright-build npm \
    && resolved_arch="${TARGETARCH:-${BUILD_ARCH}}" \
    && case "${resolved_arch}" in \
      amd64) \
        codex_target="x86_64-unknown-linux-musl"; \
        codex_sha256="${CODEX_SHA256_AMD64}"; \
        gh_arch="amd64"; \
        gh_sha256="${GH_SHA256_AMD64}"; \
        ;; \
      arm64|aarch64) \
        codex_target="aarch64-unknown-linux-musl"; \
        codex_sha256="${CODEX_SHA256_AARCH64}"; \
        gh_arch="arm64"; \
        gh_sha256="${GH_SHA256_AARCH64}"; \
        ;; \
      *) \
        echo "Unsupported architecture: ${resolved_arch}; supported architectures: amd64, aarch64" >&2; \
        exit 1; \
        ;; \
    esac \
    && codex_archive="codex-${codex_target}.tar.gz" \
    && curl --fail --show-error --silent --location \
      --output "/tmp/${codex_archive}" \
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${codex_archive}" \
    && printf '%s  %s\n' "${codex_sha256}" "/tmp/${codex_archive}" | sha256sum --check --strict - \
    && tar --extract --gzip --file "/tmp/${codex_archive}" --directory /tmp \
    && install -d -m 0755 /usr/local/libexec \
    && install -m 0755 "/tmp/codex-${codex_target}" /usr/local/libexec/codex-real \
    && rm -f "/tmp/${codex_archive}" "/tmp/codex-${codex_target}" \
    && codex_version_output="$(/usr/local/libexec/codex-real --version)" \
    && [[ "${codex_version_output}" == "codex-cli ${CODEX_VERSION}" ]] \
    && gh_archive="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" \
    && curl --fail --show-error --silent --location \
      --output "/tmp/${gh_archive}" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_archive}" \
    && printf '%s  %s\n' "${gh_sha256}" "/tmp/${gh_archive}" | sha256sum --check --strict - \
    && tar --extract --gzip --file "/tmp/${gh_archive}" --directory /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/${gh_archive}" "/tmp/gh_${GH_VERSION}_linux_${gh_arch}" \
    && gh_version_output="$(gh --version | head -n 1)" \
    && [[ "${gh_version_output}" == "gh version ${GH_VERSION} "* ]] \
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
    && /usr/bin/bwrap --version \
    && rm -rf /tmp/npm-cache \
    && apk del .playwright-build

COPY rootfs /

RUN printf '%s\n' "${BUILD_VERSION}" > /usr/local/share/codex-ha/app-version \
    && find /etc/codex/skills/ha-feedback -type d -exec chmod 0755 {} + \
    && find /etc/codex/skills/ha-feedback -type f -exec chmod 0644 {} + \
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
      /etc/codex/requirements.toml \
      /usr/local/lib/codex-ha/browser-approval.sh \
      /usr/local/lib/codex-ha/sensitive-path-policy.sh \
      /usr/local/lib/codex-ha/supervisor-credential.sh \
      /usr/local/share/codex-ha/AGENTS.md \
      /usr/local/share/codex-ha/browser-auth-check.mjs \
      /usr/local/share/codex-ha/browser-user-admin.mjs \
      /usr/local/share/codex-ha/ha-memory-core.mjs \
      /usr/local/share/codex-ha/ha-memory-ha-client.mjs \
      /usr/local/share/codex-ha/ha-memory-mcp.mjs \
      /usr/local/share/codex-ha/ha-memory.mjs \
      /usr/local/share/codex-ha/ha-feedback.mjs \
      /usr/local/share/codex-ha/playwright-init-page.ts \
      /usr/local/share/codex-ha/playwright-mcp-proxy.mjs \
      /usr/local/share/codex-ha/playwright-mcp.json \
      /usr/local/share/codex-ha/user-files-update.mjs \
      /usr/local/share/codex-ha/app-version

RUN install -d -m 0700 /data/home /data/codex /data/github-cli /run/codex-ha \
    && install -d -m 0755 /config \
    && codex_version_output="$(codex --version)" \
    && [[ "${codex_version_output}" == "codex-cli ${CODEX_VERSION}" ]] \
    && gh_version_output="$(gh --version | head -n 1)" \
    && [[ "${gh_version_output}" == "gh version ${GH_VERSION} "* ]] \
    && [[ ! -e /usr/bin/tempio ]] \
    && node --check /usr/local/share/codex-ha/ha-feedback.mjs \
    && ha-feedback --help | grep -Fq 'ha-feedback github submit'

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="Home Assistant App: Codex for Home Assistant (DEV)" \
  org.opencontainers.image.description="Development build of Codex CLI, verified feedback reports, Playwright browser, Ingress terminal, and public-key SSH for Home Assistant" \
  org.opencontainers.image.version="${BUILD_VERSION}" \
  org.opencontainers.image.source="https://github.com/Kanu-Coffee/codex-for-home-assistant" \
  org.opencontainers.image.licenses="Apache-2.0"
