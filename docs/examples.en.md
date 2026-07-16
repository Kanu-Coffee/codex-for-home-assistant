# Codex for Home Assistant prompt examples

[한국어](examples.ko.md) · [Back to README](../README.en.md) · [User guide](../codex_home_assistant/DOCS.en.md)

Copy any prompt below and adapt it to your own entities, routines, and goals. A safe starting sequence is **inspect → propose → approve → make a small change → validate**.

> [!TIP]
> Add phrases such as “do not change anything yet,” “show me the diff first,” “apply only after I approve,” and “validate with fresh state after applying” to make the working boundary explicit.

## Start by understanding your environment

```text
Audit my current Home Assistant setup in read-only mode.
Summarize the following in a table, but do not change files, registries,
or device states yet:

1. Dashboards and major views
2. Automations, scripts, and scenes
3. Unavailable or unknown entities
4. Recent Core and App errors
5. Duplicate or ambiguous entity names
6. Improvement candidates that require a backup and validation
```

## Bug and feature feedback

`$ha-feedback` is a preset for validating a bug or feature request about this app in read-only mode and preparing a report that is safe to publish. The initial request authorizes investigation and report preparation only, not GitHub submission.

### Bug report

#### Natural-language bug request

```text
I found the following problem in Codex for Home Assistant:
<reproducible symptom, when it occurs, and user impact>

Use the $ha-feedback bug workflow to validate it in read-only mode.
Identify the app and Home Assistant versions, affected path, minimal reproduction,
expected behavior, and actual behavior. Classify every check as PASS, FAIL, NOT_TESTED,
or NOT_RUN and include the supporting evidence. Do not change Home Assistant files,
registries, device states, or app options, and do not restart, update, call services,
or apply a fix.

Do not collect complete logs or original screenshots; retain only the minimum
sanitized evidence that is safe to publish. If this may be a vulnerability,
authentication bypass, or credential exposure, stop the public report and GitHub
submission flow immediately and show only the private security reporting route.
Create the report bundle, but do not submit it yet. Show me the final public preview.
```

#### Explicit bug invocation

```text
$ha-feedback bug <describe the reproducible symptom and impact in one or two sentences>
```

### Feature request

#### Natural-language feature request

```text
I want to propose the following feature for Codex for Home Assistant:
<who needs to achieve what, in which situation, and what currently blocks them>

Use the $ha-feedback feature workflow to validate it in read-only mode.
Summarize what the current documentation and product already support, the evidence
checked, alternatives and current workarounds, proposed user-visible behavior,
compatibility, security and privacy risks, out-of-scope items, and observable
acceptance criteria. Do not change Home Assistant configuration or state, and do not
implement or install the feature.

Do not include identifying data, complete logs, or original screenshots. If the request
relates to a vulnerability, authentication bypass, or credential exposure, stop the
public flow and show only the private security reporting route. Create the report bundle,
but do not submit it yet. Show me the final public preview.
```

#### Explicit feature invocation

```text
$ha-feedback feature <describe the needed behavior and use case in one or two sentences>
```

### Report bundle and submission boundary

Nothing is changed except the report files. Every run creates an isolated bundle at:

```text
/config/codex-workspace/feedback/<UTC>-<kind>-<report-id>/
```

- `public-report.md`: sanitized report for a person to review and paste into a public issue
- `report.json`: structured local report containing checks, results, and evidence
- `submission.json`: optional receipt containing only the issue number, URL, and submission time after a successful direct submission

None of these files may contain tokens, credentials, private URLs or IP addresses, usernames, or identifying entity, device, area, or household information. Only `public-report.md` is intended for public use; do not attach the JSON files or the entire directory. A short sanitized log excerpt may be included only after it is previewed separately and the user approves that exact text. A screenshot must be a separately sanitized copy with notifications and identifying content removed, and a person must review the image and its metadata before attaching it manually. Never use an original or automatic attachment.

If validation suggests a vulnerability, authentication bypass, or credential exposure, stop public search and submission, keep the local report private, and use [private vulnerability reporting](https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new).

The submission target is fixed to `Kanu-Coffee/codex-for-home-assistant`. These commands only check connection state, start an opt-in login, log out, or show the fixed Issue Form URL:

```bash
ha-feedback github status
ha-feedback github login
ha-feedback github logout
ha-feedback github url <report.json|report-directory>
ha-feedback github submit <report.json|report-directory>
```

When direct submission is enabled, GitHub CLI credentials persist at `/data/github-cli`. Home Assistant App backups may include this directory, so treat those backups as sensitive. Do not log in when direct submission is unnecessary, and use `ha-feedback github logout` when the connection is no longer needed.

After read-only status and candidate search, Codex must preview the final repository, issue kind, title, and public body, then obtain a separate explicit confirmation such as “submit this preview.” The cryptographically random preview token is single-use and expires after ten minutes. A wrong, expired, used, or failed confirmation requires a fresh preview and confirmation. If candidate search or the final report-ID duplicate check is unavailable, no issue is created and the workflow falls back to the Web Form.

Only when both searches and GitHub CLI authentication succeed may the helper send the validated body to `gh issue create --body-file -` over stdin. Direct submission is never retried automatically. A `gh` failure, unexpected URL, or receipt-write failure may leave a hidden `.submission.lock` that blocks another direct submission for the report. Do not remove the lock; search for an existing issue first, then use `ha-feedback github url <report>`, open the [Issue Form](https://github.com/Kanu-Coffee/codex-for-home-assistant/issues/new/choose), review the preserved `public-report.md`, and paste it manually.

## Dashboards

### Bubble Card mobile home

```text
First check whether Bubble Card is installed and how the current dashboard is stored.
If it is not installed, do not change files; explain only the required installation steps
and risks.

If it is installed, preserve the existing dashboard and design a new mobile view:
- Prioritize a one-column layout at 390px wide
- Top: home mode, occupancy, and weather
- Middle: frequently used lights and climate controls
- Bottom: doors/windows, low batteries, and unavailable entities
- Optimize for one-handed use and nighttime readability

Show me the entities, card structure, and YAML diff first.
After I approve, apply it, then inspect screenshots, console warnings/errors,
and failed network requests at both 1440x900 and 390x844.
```

### Improve an existing dashboard

```text
Analyze my default dashboard in read-only mode.
Find duplicate cards, excessive scrolling, elements clipped on mobile,
and important states that are buried too far down the page.

Preserve the current features and entities. Suggest three minimal improvements
in priority order, but do not change the dashboard yet.
```

### Tablet wall panel

```text
Design a dashboard draft for a 10-inch landscape tablet in the kitchen.
It will remain on, so use large text and clear state colors.
Fit weather, family calendar, lighting, climate, and door/window states on one screen.

Use only cards that are currently installed. If a required entity is missing,
mark it instead of substituting another one. Show me the wireframe and card list first.
```

## Automations

### Find ideas from daily routines

```text
Our weekday routine is:
- Wake at 07:00
- Leave at 08:10
- Return between 18:30 and 19:30
- Go to bed at 23:30

Inspect the current presence, light, temperature, door, and power sensors and existing
automations in read-only mode. Suggest five new automations in priority order.
For each, include the benefit, trigger, conditions, action, safeguards against false
triggers, and required entities. Mark overlaps with existing automations and do not
apply anything yet.
```

### Away mode

```text
Design an away automation for when the last person leaves home.
First inspect the available occupancy sensors and devices.
Consider turning off lights and climate equipment, sending an open-window alert,
and checking security status.

Do not operate locks, alarms, or garage doors; suggest notifications only.
Include conditions that handle unknown/unavailable states and brief occupancy flapping.
Show me the plan and YAML first.
```

### Night lighting

```text
I want a low-glare hallway light when motion is detected at night.
Inspect the current illuminance, motion, and hallway-light entities and existing
automations.

Propose a draft for 23:00–06:00 with low brightness, automatic shutoff after a delay,
and a safeguard that does not turn off a light someone switched on manually.
Do not apply it before I approve.
```

### Find automation conflicts

```text
Find automations that may control the same lights or climate devices to conflicting values.
Summarize triggers that occur close together, restart/queued/single mode effects,
opposing service calls, and cases that undo a manual action.
Do not change anything. Suggest the smallest solutions first.
```

## Entity and device cleanup

### Unused candidates

```text
Find entities that are not referenced by dashboards, automations, scripts, scenes,
or templates. Separate disabled entities, unavailable entities, traces of removed
integrations, and duplicate names. For each candidate, show its device/integration,
the latest available evidence, and removal risk in a table.

Warn that external apps or voice assistants may still use an entity,
and do not change the registry.
```

### Consistent naming

```text
Analyze entity and device display names by area.
Find duplicates, repeated room names, mixed Korean/English naming,
and names that do not reveal the device's role.
Suggest a consistent naming convention and rename candidates.

Explain the different impact of changing an entity_id versus a display name,
and do not rename anything yet.
```

### Battery and connection quality

```text
Summarize devices that are low on battery, have been unavailable for a long time,
or appear to disconnect often. Do not diagnose a failure from one current state alone;
use history and integration logs only when they are available as evidence.
Suggest an order for checking battery replacement, re-pairing, and device placement.
```

## Errors and maintenance

### Configuration errors

```text
Diagnose my Home Assistant configuration in read-only mode.
Run ha-config-check and inspect related YAML, include paths, and recent Core logs.
Rank possible causes by strength of evidence.

Show me the smallest fix diff and a rollback method,
but do not apply it or restart anything before I approve.
```

### Pre-update review

```text
Review my current Home Assistant state before an update.
Summarize pending repairs, deprecated configuration, custom integration warnings,
items that require a backup, and a rollback plan.

Do not perform the update, restart anything, or operate apps. Create only a checklist.
```

### Slow dashboard

```text
Investigate why my current dashboard feels slow.
Use the Headless browser to inspect desktop and mobile console and network results.
Identify large images, failed resources, excessive custom cards, and repeated templates.

Do not infer real-device performance or network speed from browser results alone.
Suggest the smallest improvements that can be validated.
```

## Memory and home context

### Remember an explicit alias and purpose

```text
In our home, entity light.kitchen_main is called the “prep light,”
and we use it while preparing breakfast. This is durable information;
remember it for future tasks.
```

### Remember a home-wide preference

```text
For alerts in our home, prefer mobile notifications over voice announcements.
This is a durable preference that applies across the home; remember it.
```

Avoid storing current state, information that applies “today only,” guesses, or observations from pages and logs as durable memory. When correcting memory, identify the target and previous meaning precisely.

```text
I need to correct the purpose of the prep light. We use it for indirect nighttime lighting,
not breakfast preparation. If this conflicts with the existing memory,
do not overwrite it silently; show me what would change first.
```

## Safety-critical work

Keep inspection and execution separate, as in these examples:

```text
Audit the front-door lock automations in read-only mode.
Never call an unlock service. Review only the triggers, conditions,
failure behavior, and notification paths.
```

```text
Inspect the current heating automation configuration and sensor states.
Do not change the setpoint or mode; suggest only energy-saving candidates.
Make an actual change only one item at a time after I approve it separately.
```

## A template for better requests

```text
Goal:
Current situation:
What must be preserved:
Scope to inspect:
Out of scope for changes:
Result wanted before approval: plan / table / YAML / diff
Validation after approval: ha-config-check / fresh API / desktop+mobile browser
Rollback method:
```

Specific requests are easier to review. Include real entity IDs, desired time ranges, and the safe default behavior for failures, but never include tokens, passwords, or internal URLs that should not be disclosed.
