# Contributing

Contributions to documentation, tests and the Home Assistant app are welcome. The project is currently experimental and changes must preserve the explicit security boundaries around `/config`, Home Assistant APIs, SSH, browser authentication and local memory.

## Before changing code

1. Read [AGENTS.md](AGENTS.md) and [development/rules.md](docs/development/rules.md).
2. Check the current evidence and open gaps in [development/progress.md](docs/development/progress.md).
3. Read the relevant product, architecture, security and test contracts in [docs/development](docs/development/README.md).
4. Keep unrelated local changes intact.

## Documentation structure

- `README.md` and `README.en.md`: public GitHub landing pages
- `codex_home_assistant/README*.md`: short App Store descriptions
- `codex_home_assistant/DOCS*.md`: detailed user guides
- `docs/examples.*.md`: prompt cookbook
- `docs/development/`: active engineering contracts and evidence
- `docs/archive/`: historical documents that are not current instructions

When a user-facing behavior changes, update Korean and English documentation together. Keep installation and examples outcome-focused; move CI evidence, digests and implementation internals to development records or the changelog.

## Runtime boundaries

Treat the following as runtime or delivery changes that require proportional tests:

- `codex_home_assistant/rootfs/**`
- `codex_home_assistant/Dockerfile`
- `codex_home_assistant/playwright/package*.json`
- `codex_home_assistant/config.yaml` and translations
- `.github/workflows/**`
- `tests/**`

Do not weaken the following without an explicit architecture and security decision:

- public-key-only SSH
- no Supervisor `admin`, Docker API, Home Assistant `full_access`, host network, or AppArmor disablement
- secret redaction and root-only persistent credentials
- fail-closed browser identity validation
- bounded memory retrieval and exclusion of raw conversations, credentials and state history

## Checks

Install development dependencies and run the relevant checks:

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -ra
yamllint -c .yamllint .
npx --yes markdownlint-cli2@0.23.0
git diff --check
```

On a compatible Linux/Docker environment, runtime changes should also run the applicable image and smoke tests documented in [test_plan.md](docs/development/test_plan.md). Do not report a HAOS or hardware path as PASS based only on mocks or a local container.

## Pull requests

- Keep the change focused and explain user impact.
- List exact checks run and distinguish PASS, NOT RUN and partial evidence.
- Do not commit credentials, private Home Assistant data or generated local caches.
- Add regression coverage for fixed defects when practical.
- Include screenshots only after removing user, location, entity, URL and token data.

By contributing, you agree that your contribution is licensed under the project's [Apache License 2.0](LICENSE).
