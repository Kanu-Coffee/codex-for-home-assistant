---
name: ha-feedback
description: Prepare privacy-safe, evidence-based bug reports and feature proposals for Codex for Home Assistant with the image-managed ha-feedback helper. Use when a user invokes the ha-feedback skill in bug or feature mode, reports a suspected App bug, proposes an App feature, or asks to preview or submit that feedback to GitHub.
---

# Home Assistant Feedback

Create a structured feedback report without changing Home Assistant. Treat GitHub issue creation as a separate, confirmed external write.

## Modes

- `$ha-feedback bug <증상>`: investigate and report an observed defect.
- `$ha-feedback feature <요청>`: investigate and propose a new or changed capability.

For an implicit invocation, infer `bug` or `feature` only when the intent is clear. Ask one concise question when it is ambiguous. Do not turn a support question into a public report without the user's request.

## Non-negotiable boundaries

- Keep investigation read-only. Never modify Home Assistant configuration, registries, dashboards, automations, devices, App data, or the project.
- Never reload, restart, update, recover, restore, install, remove, or call a Home Assistant service. A finding does not authorize a repair.
- Permit only a private 0600 input file and helper-generated report artifacts. Never put user text, report bodies, logs, screenshots, or secrets on a command line.
- Do not collect or attach logs or screenshots by default. Read [references/privacy.md](references/privacy.md) before collecting evidence.
- If the report may involve a vulnerability, authentication or authorization bypass, credential exposure, or another security issue, set `security_issue` to true and stop every public search and submission step. Follow the private path in the privacy reference.

## Build the report

1. Read [references/bug.md](references/bug.md) for `bug` or [references/feature.md](references/feature.md) for `feature`. Use its exact draft fields.
2. Separate observed facts from inference. Mark missing or unexecuted checks honestly; never invent versions, reproduction, evidence, or results.
3. Create a temporary file with `mktemp`, verify mode `0600`, and write the structured JSON with a file-writing tool rather than embedding its contents in a shell command. Include only the sanitized fields allowed by the privacy reference.
4. Run exactly one matching collection command:

   ```text
   /usr/local/bin/ha-feedback collect bug --input <0600-json-path>
   /usr/local/bin/ha-feedback collect feature --input <0600-json-path>
   ```

5. Capture the JSON paths printed by the helper, then remove the temporary input file. Treat the returned report JSON or report directory as the report handle.
6. Run `/usr/local/bin/ha-feedback validate <report>` and resolve every validation error by correcting the structured input and collecting again. Do not hand-edit rendered output.
7. Run `/usr/local/bin/ha-feedback render <report>`. Present the rendered, sanitized report and state each check as `PASS`, `FAIL`, `NOT_TESTED`, or `NOT_RUN` with evidence or a reason.

Stop after rendering unless the user asks to prepare or submit a GitHub issue.

## Prepare and submit

Read [references/submission.md](references/submission.md), then use only `/usr/local/bin/ha-feedback github ...` for GitHub workflow operations.

1. Run `/usr/local/bin/ha-feedback github status`.
2. Run `/usr/local/bin/ha-feedback github submit <report>` without `--confirm`. This is preview-only. If candidate search is unavailable, accept the returned Web Form fallback; do not try to create an issue or obtain a token another way.
3. Show issue candidates first. If a likely duplicate exists, pause and let the user choose whether to use it or continue.
4. Show the exact final repository, title, and complete body. Ask for explicit confirmation of that exact payload. An earlier request to "submit" is not confirmation, and any edit invalidates the preview.
5. Treat a returned confirmation token as private, random, ten-minute, single-use state. Only after an unambiguous confirmation in the current user turn, re-run validation and use that token:

   ```text
   /usr/local/bin/ha-feedback github submit <report> --confirm <token>
   ```

6. After any wrong, expired, used, or failed confirmation, discard the token, create and show a fresh preview, and obtain confirmation again. Never automatically retry a direct submission.
7. The helper must fail closed if the final remote report-ID duplicate check is unavailable. It passes the already validated Markdown to `gh issue create --body-file -` over stdin; never call `gh` directly or reopen a different body for submission.
8. If authenticated submission is unavailable or fails, run `/usr/local/bin/ha-feedback github url <report>` only after the same payload confirmation and use the Web Form fallback; the user performs the final browser submission. If the helper reports an uncertain external result, do not delete `.submission.lock` or retry directly. Ask the user to check the fixed repository for the report ID before using the fallback.

Never run `github login` or `github logout` implicitly. Run them only at the user's explicit request. Never submit a security report publicly.
