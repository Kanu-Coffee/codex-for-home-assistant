# Privacy and security gate

- Collect the minimum facts needed for the report. Do not collect, read, or attach logs or screenshots by default.
- If the user explicitly requests a short log excerpt, sanitize it, show that exact excerpt separately, and ask for explicit approval before adding it to `evidence`. Without that approval, do not include it. Never attach full logs, databases, backups, configuration exports, or `.storage` content.
- Never read, store, or upload a screenshot or other file automatically. The user may inspect and attach one manually in the GitHub web form after redaction; the report may only state that separately reviewed evidence is available.
- Exclude tokens, authorization headers, cookies, `auth.json`, `secrets.yaml`, SSH keys, credentials, private URLs or IPs, usernames, and identifying entity, device, area, person, household, or location data.
- Do not open a secret source merely to redact it. Do not include secret values in tool input, terminal output, filenames, command arguments, reports, or GitHub URLs.
- Put structured input only in a temporary 0600 JSON file. Keep user text and report bodies off the command line. Delete the input after collection.
- Treat vulnerability indicators, authentication or authorization bypass, credential exposure, remote code execution, path traversal, cross-user access, or unsafe privileged control as `security_issue: true`.

For `security_issue: true`, keep any local report private and do not run GitHub candidate search, preview, URL, or submit commands. Direct the user to GitHub private vulnerability reporting:

https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new
