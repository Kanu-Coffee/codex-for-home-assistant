# Third-Party Notices

This project builds a container image from third-party open-source software. The upstream projects retain their own copyrights and licenses. This notice is informational and does not replace the license texts supplied by each upstream project or Alpine package.

## Runtime foundations

### Home Assistant base image

- Component: `ghcr.io/home-assistant/base:3.24`
- Current inspected M1 image metadata: Home Assistant base release `2026.06.1`, Alpine Linux `3.24`, amd64
- Source: <https://github.com/home-assistant/docker-base>
- License for the Home Assistant base-image project: Apache License 2.0

The Home Assistant base image itself includes S6 Overlay, Bashio, TempIO, Alpine Linux, and their transitive dependencies. Their license information is supplied by the upstream image and installed Alpine package database.

### OpenAI Codex CLI

- Component: `codex-cli 0.144.1`
- Artifact: `codex-x86_64-unknown-linux-musl.tar.gz` from the official `rust-v0.144.1` release
- Source: <https://github.com/openai/codex>
- License: Apache License 2.0

The release archive is downloaded during the image build and verified against the SHA-256 value pinned in `codex_home_assistant/Dockerfile`.

### Playwright MCP runtime

The locally built `0.2.0` amd64 image pins the npm dependency graph with `codex_home_assistant/playwright/package-lock.json`:

| Package | Source | License in npm metadata |
| --- | --- | --- |
| `@playwright/mcp 0.0.78` | <https://github.com/microsoft/playwright-mcp> | Apache-2.0 |
| `playwright 1.62.0-alpha-1783623505000` | <https://github.com/microsoft/playwright> | Apache-2.0 |
| `playwright-core 1.62.0-alpha-1783623505000` | <https://github.com/microsoft/playwright> | Apache-2.0 |

The lockfile also records optional macOS-only `fsevents 2.3.2` under the Playwright package. It is not installed in the Linux amd64 runtime. The build sets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`; it does not redistribute a Playwright-downloaded browser. Browser execution uses Alpine's separately packaged `chromium-headless-shell` listed below.

Upstream Playwright does not list Alpine Linux/musl as a supported platform for its bundled browser binaries. This project deliberately combines Playwright MCP with Alpine's system Chromium and must validate that combination for each resolved image. That compatibility caveat does not change the upstream license terms.

## Direct Alpine packages

The Dockerfile directly requests the runtime packages below. Versions and SPDX-style license identifiers were read from the locally built amd64 `0.2.0` image on 2026-07-14. A later rebuild can resolve newer package revisions. The installed image's `apk list --installed` and `apk info --license <package>` output is authoritative for that exact image.

| Package/repository revision | Upstream | License reported by Alpine |
| --- | --- | --- |
| bash 5.3.9-r1 | <https://www.gnu.org/software/bash/> | GPL-3.0-or-later |
| ca-certificates 20260611-r0 | <https://www.mozilla.org/> | MPL-2.0 AND MIT |
| chromium-headless-shell 150.0.7871.114-r0 | <https://www.chromium.org/> | BSD-3-Clause |
| coreutils 9.11-r0 | <https://www.gnu.org/software/coreutils/> | GPL-3.0-or-later |
| curl 8.20.0-r1 | <https://curl.se/> | curl |
| font-noto-cjk 0_git20220127-r1 | <https://github.com/notofonts/noto-cjk> | OFL-1.1 |
| font-noto-emoji 2.051-r0 | <https://github.com/googlefonts/noto-emoji> | OFL-1.1 |
| git 2.54.0-r0 | <https://git-scm.com/> | GPL-2.0-only |
| jq 1.8.1-r0 | <https://jqlang.github.io/jq/> | MIT |
| less 702-r0 | <https://www.greenwoodsoftware.com/less/> | GPL-3.0-or-later OR BSD-2-Clause |
| nano 9.1-r0 | <https://www.nano-editor.org/> | GPL-3.0-or-later |
| nginx 1.30.3-r0 | <https://nginx.org/> | BSD-2-Clause |
| nodejs 24.17.0-r0 | <https://nodejs.org/> | MIT |
| openssh 10.3_p1-r0 | <https://www.openssh.com/portable.html> | SSH-OpenSSH |
| ripgrep 15.1.0-r0 | <https://github.com/BurntSushi/ripgrep> | MIT OR Unlicense |
| shadow 4.18.0-r1 | <https://github.com/shadow-maint/shadow> | BSD-3-Clause |
| sqlite 3.53.2-r0 | <https://www.sqlite.org/> | blessing |
| tmux 3.6b-r0 | <https://github.com/tmux/tmux> | ISC |
| ttyd 1.7.7-r0 | <https://github.com/tsl0922/ttyd> | MIT |
| yamllint 1.38.0-r0 | <https://github.com/adrienverge/yamllint> | GPL-3.0-or-later |
| yq-go 4.53.3-r0 | <https://github.com/mikefarah/yq> | MIT |

The Docker build also requests `npm 11.12.1-r0` as a temporary virtual build dependency, whose Alpine-reported license is Artistic-2.0. It runs the pinned `npm ci` installation and is then removed; npm itself is not present in the final runtime image. Chromium and Node.js include their own transitive third-party notices, which remain available through the Alpine package sources and installed license material.

Transitive Alpine packages are installed by the Home Assistant base image or by the packages above; they are not separately selected in this repository. To inventory an exact built image, run:

```sh
apk list --installed
apk info --license PACKAGE_NAME
```

## Design and structure references

The following upstream repositories were consulted for current Home Assistant App layout and SSH/web-terminal operational patterns:

- Home Assistant example App repository: <https://github.com/home-assistant/apps-example> — Apache License 2.0
- Home Assistant Community App, Advanced SSH & Web Terminal: <https://github.com/hassio-addons/app-ssh> — MIT License, copyright 2017-2026 Franck Nijhof

The current source tree does not vendor files from `hassio-addons/app-ssh`. It uses that project as a design reference and intentionally does not copy its optional host-network, Docker API, host hardware, or other elevated-access features.

## License locations

Full license texts and copyright notices are available from the linked upstream source repositories and Alpine source packages. Distributors of a built image should retain the upstream image metadata, generate an image-specific SBOM/package inventory, and satisfy the license obligations of the exact resolved package set.
