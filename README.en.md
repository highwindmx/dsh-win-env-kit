# dsh-win-env-kit

A publishable DSH skills bundle that packages the **Windows environment rules** together with the **dependency-free tools that check them**. Install once, use from any workspace.

- Package: `dsh-win-env-kit`
- Skill: `win-env-kit`
- Version: `0.2.1` (independent of any workspace `VERSION` file)

## What is inside

```
dsh-win-env-kit/
  lib/index.js                     Cordis plugin: registers the skills provider
  lib/config.mjs                   the Config schema (one switch per rule)
  lib/rules.mjs                    rule catalog + body filtering
  scripts/verify-provider.mjs      machine-checkable self test (npm run verify)
  cordis.patch.yml                 host-plane insert row (id: win-env-kit)
  dsh.plugin.json                  compatibility manifest
  icon.svg / locale/*.json         display metadata (en + zh)
  skills/win-env-kit/
    SKILL.md                       the nine rules (generalized, portable)
    HOST-PROFILE.md                example measurements from the original host
    .gitattributes.example         CRLF/LF split template to copy into a repo
    tools/                         the six zero-dependency scripts
      dsh-env-lint.mjs             BOM / EOL / U+FFFD / GBK / SCRATCH checks
      build-audit.mjs              MOTW / TRUST-MARK / SIGN / PE / TEMP-PATH
      dsh-privacy-gate.mjs         screenshot privacy gate (ALLOW / BLOCK)
      dsh-teardown.mjs             ledger-based cleanup (gone != error)
      dsh-doc-lock.mjs             claim/check/release lock for shared docs
      dsh-screenshot.ps1           window-scoped capture (ASCII + CRLF)
```

## Install (current DSH profile)

Use `plugin_manager` with `action: install_bundle` and this package's **absolute directory** as `target`. Do not hand-edit a profile's `package.json` or `cordis.patch.yml`; `install_bundle` performs those steps. Changes affect every session in that profile and survive restart.

After enabling, `win-env-kit` appears in the session skill catalog. Publishing to npm (`npm publish`) is a separate, deliberate step.

## Choosing which rules are on

All nine rules are on out of the box. To narrow the set, set `config` on this plugin's row in **your profile's** `cordis.patch.yml` (not this package's copy — a later layer overrides it):

```yaml
- id: win-env-kit
  config:
    enabledRules: []
    rule1: true
    rule2: true
    rule3: false        # nothing here ships a binary
    rule4: false        # ... so no SmartScreen reputation work either
    rule5: true
    rule6: true
    rule7: true
    rule8: true
    rule9: true
```

…or name exactly the rules to keep, which wins over the per-rule switches, so the per-rule fields can be left out (omitted fields keep their schema default and are then ignored):

```yaml
- id: win-env-kit
  config:
    enabledRules: [1, 2, 5, 7, 8]
```

What the selection does:

- A disabled rule's `## N.` section is dropped from the body before the model sees it. The preamble, the tool-resolution notes, the verification commands and the host-profile pointer stay.
- A verification command tagged `# rules 3-4 + 9` goes with its rules; an untagged command always stays. A fence that loses every line is removed rather than left empty.
- The published description and the body's opening `> **Configured subset:**` notice carry the same sentence — `This install enables rules 1, 2, 5, 7, 8; rules 3, 4, 6, 9 are off.` — so the trigger text and the loaded skill never disagree about which rules are live. A skill that still advertised a rule it no longer contains would be worse than either extreme.
- `config` is replaced wholesale, never deep-merged: restate every field you want to keep. `enabledRules: []` means "let the per-rule switches decide".
- A value that is not a recognised "off" token (`false`, `"false"`, `0`) leaves the rule on, so a malformed row cannot silently mute the skill.

The settings UI renders one toggle per rule from the schema in `lib/config.mjs`; each rule's description is its `SKILL.md` heading.

## How the bundled tools are resolved

When the skill is loaded, the `skill` tool reports a base directory, for example:

```
Base directory for this skill: <profile>/node_modules/dsh-win-env-kit/skills/win-env-kit
Resolve relative paths mentioned by this skill against the base directory before using them.
```

That directory comes from the provider's `resourceBase: { kind: 'directory', path: ... }`. **Every `tools/...` path in `SKILL.md` is relative to that base directory, not to the workspace CWD.** Resolve it to an absolute path first:

```powershell
node "<SKILL_BASE>/tools/dsh-env-lint.mjs" .
node "<SKILL_BASE>/tools/build-audit.mjs" out\app.exe --strict
node "<SKILL_BASE>/tools/dsh-privacy-gate.mjs" "_scratch\*\shots\*.png" --strict
```

The `.` argument is still the workspace CWD, so the lint/audit target is the user's project. No copy into the workspace is needed.

## Portability

The rules are general; the original machine's measured values are **examples**, kept in `HOST-PROFILE.md` and clearly labelled. On a new machine:

- Re-measure the system code page (`chcp`), PowerShell version, screen size, Defender/SmartScreen state, and code-signing certificate availability.
- `dsh-privacy-gate.mjs` defaults to a 1280x800 conservative full-screen floor; override with `--screen WxH` or the `DSH_SCREEN` environment variable when the display differs.
- The detection regexes inside the scripts (`S-1-4-\d`, `dsh-spill-`, `Temp\dsh-`) are **detection rules**, not machine identity. Keep them.

## Add the index to your repo

`AGENTS.md` is a workspace-specific index and is intentionally not shipped. Copy this fragment into a repo's `AGENTS.md`:

```markdown
## Windows environment rules

This is an index, not the manual. Load the `win-env-kit` skill (provided by the
`dsh-win-env-kit` plugin) before working on build scripts, packaging, text-file
encoding, screenshots, or distributable artefacts. Verification commands:

    node "<SKILL_BASE>/tools/dsh-env-lint.mjs" .
    node "<SKILL_BASE>/tools/build-audit.mjs" <artefact> --strict
    node "<SKILL_BASE>/tools/dsh-privacy-gate.mjs" "_scratch\*\shots\*.png" --strict
```

## Verification (what "done" means)

```powershell
npm pack --dry-run --json     # the six scripts, SKILL.md, icon, locale are all listed
npm run verify                # provider + rule selection + Config schema
node tools/dsh-env-lint.mjs . # UTF-8 / LF-CRLF / no U+FFFD / no SCRATCH
```

`npm run verify` asserts: `list()` returns exactly one candidate named `win-env-kit`; `get()` returns a directory `resourceBase` whose `tools/dsh-env-lint.mjs` exists; the body contains the verification section; no host-specific SID leaked back into `SKILL.md`. It then drives the selection: all nine sections present by default with no notice, `rule5: false` removing exactly section 5 while naming the rule in the notice and the description, `enabledRules` beating the per-rule switches, and `ruleTagsOf` expanding `1-2` while ignoring a version string before the `#`. The Config schema is checked against real schemastery when it resolves, otherwise against a chainable stub. A non-zero exit is a failed build.

## Maintenance

`skills/win-env-kit/tools/` is a byte-for-byte copy of the workspace `tools/`. If a script changes, update both copies and re-check with `Get-FileHash`, then re-run `npm run verify`. `dsh-screenshot.ps1` must stay **pure ASCII + CRLF + no BOM**; all other files are UTF-8 without BOM and LF.

`lib/rules.mjs` holds each rule's number and title, and those titles must match the `## <n>. <title>` headings in `SKILL.md` — `npm run verify` fails if a rule has no section, and a title that drifts only degrades the settings-UI label.

The `SKILL.md` frontmatter `description` is the only trigger text injected into every session's catalog, and the host hard-truncates it to 500 characters. Keep it short and front-load the artefact-shaped triggers (writing a `.ps1`, `.md` or `.csv`, moving or deleting files) rather than the task's goal — a disk-cleanup or inventory task still writes scripts and reports. `npm run verify` fails if the description exceeds 500 characters. The body opens with a load-time self-check that re-matches the plan against that artefact list.

## License

MIT
