# GitHub submission gate

Use the helper for every GitHub operation; do not call `gh` directly or handle GitHub tokens.

1. Validate and render the report immediately before preparing a submission.
2. Run `ha-feedback github status`. Run login or logout only when the user explicitly requests that account action.
3. Run `ha-feedback github submit <report>` without confirmation. Candidate search must succeed before the helper returns a token. If search is unavailable or malformed, do not create an issue or find a token another way; show the exact payload and use the returned Web Form fallback.
4. Show candidate issues before the proposed payload. For each candidate, show its title, URL, and why it may overlap. Do not submit while the user is deciding whether to use a likely duplicate.
5. Show the exact repository, exact title, label, and complete final body. Ask whether to submit that exact payload.
6. Treat the returned confirmation token as private, cryptographically random state bound to the exact payload. It expires after ten minutes and can be consumed only once.
7. Accept only an unambiguous confirmation in the current user turn after the preview. A prior blanket instruction, silence, or approval of an older preview is insufficient.
8. If anything changes, the token is wrong, expired, used, or any confirmation attempt fails, discard it. Generate a new preview, show candidates and the complete payload again, and reconfirm.
9. For authenticated CLI submission, pass only the returned token to `ha-feedback github submit <report> --confirm <token>`. Never retry this command automatically.
10. The helper must revalidate privacy and rendering, then complete a remote exact report-ID duplicate check. If that search is unavailable, it creates no issue and requires a fresh preview before any later direct attempt.
11. The helper sends the validated Markdown over stdin with `gh issue create --body-file -`; never call `gh` directly or substitute another body path.
12. A create failure, unexpected issue URL, or receipt-write failure can leave the external result uncertain. The helper retains hidden `.submission.lock` and blocks direct retry. Do not remove the lock. Ask the user to check the fixed repository for the report ID first.
13. If CLI submission is unavailable or fails, use `ha-feedback github url <report>` only after confirmation. Let the user review and submit the prefilled Web Form; no automatic retry is allowed.

Never use either path for `security_issue: true`. Add a short log excerpt only when the user separately approves its exact sanitized text. Never read, store, or upload a screenshot or other file automatically; the user may review and attach one manually in the Web Form.
