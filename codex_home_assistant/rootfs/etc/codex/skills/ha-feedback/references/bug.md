# Bug report draft

Build one structured JSON object for `ha-feedback collect bug`. Required text fields must be explicit; write a short `Unknown`/`Not observed` explanation instead of leaving them empty, and explain unexecuted work in `checks`. Never guess.

## Sequence

1. Confirm that the affected surface belongs to Codex for Home Assistant. Separate App behavior from Home Assistant Core, Supervisor, another integration, and user configuration; record an uncertain boundary as unverified instead of assigning blame.
2. Collect only the helper's allowlisted App, Codex, Core, Supervisor, OS, architecture, and safe App-option summary. Do not open raw option, auth, storage, database, backup, log, or screenshot sources.
3. Reproduce and diagnose only with safe read-only observations. Do not modify Home Assistant, call services, reload, restart, update, recover, restore, install, or remove anything. Mark checks that cannot be run safely as `NOT_RUN` and checks without a suitable target as `NOT_TESTED`, with a reason.
4. Compare expected and actual behavior using observable evidence, including frequency only when known.
5. List unconfirmed cause candidates separately from facts, then record every unverified scope and unavailable check.

If any observation suggests a vulnerability, authentication bypass, or credential exposure, set `security_issue` to `true` and stop all public issue search, preview, URL, and submission work.

## Fields

- `affected_feature`: Short App surface or workflow name.
- `summary`: One concise, observable defect statement.
- `expected_behavior`: What should have happened.
- `actual_behavior`: What happened, including frequency when known.
- `reproduction_steps`: Minimal ordered string array from a known initial state.
- `cause_candidates`: Non-empty array of plausible causes, each explicitly labeled as unconfirmed; use an `Unknown` explanation when no responsible layer can be narrowed safely.
- `checks`: Array of `{ "name": string, "status": "PASS" | "FAIL" | "NOT_TESTED" | "NOT_RUN", "evidence": string }`.
- `evidence`: Array of short, sanitized observations. Do not add logs or screenshots by default.
- `unverified_scope`: Array of uncertainties, unavailable checks, and clearly labeled hypotheses.
- `security_issue`: Boolean. Prefer `true` whenever public safety is uncertain.
- `environment`: Object containing only `app_version`, `codex_version`, `core_version`, `supervisor_version`, `os_version`, `arch`, and `app_options`. `app_options` may contain only the helper's non-secret allowlisted names and values; never include `authorized_keys`, browser tokens, or unknown options. The helper overwrites and normalizes values it can collect.

Keep actual observations separate from suspected cause. A failed check is evidence, not proof of root cause or authorization to fix the system.
