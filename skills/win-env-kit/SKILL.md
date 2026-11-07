---
name: win-env-kit
description: Use when working on a Windows host with the DeepSeek Harness: writing or running build scripts, packaging a distributable exe/msi/zip, creating or fixing text files in a repo (UTF-8 vs a legacy system code page, CRLF-vs-LF per file type), running a smoke/screenshot test or any transient dev artefact, leaving test processes or scratch docs lying around, having multiple agents edit the same shared doc (README/AGENTS.md/CHANGELOG), a file starting to demand a security confirmation after an agent touched it (ACE / low-integrity / S-1-4 trust marks), needing to capture a child process's output inside the DSH sandbox, or when terminal output shows mojibake/`???`. Covers encoding decisions, line endings, the build-side habits that keep a binary from tripping SmartScreen, the _scratch isolation + screenshot-privacy gate that keeps desktop content out of uploads, the ledger/teardown anti-loop discipline so a manually-stopped process or deleted file never triggers an endless retry, the claim/release edit-lock that stops concurrent agents from clobbering a shared document, and the local trust-mark (ACE) diagnosis + the file-fd child-output capture workaround.
---

# Windows environment rules (portable)

Nine rules cover almost every failure. Each one names a check you can run, so "done" is observable. Rules 1–4 are about text and binaries; rules 5–8 are about transient dev artefacts, screenshots, the cleanup/anti-loop discipline, and the concurrent-edit lock for shared docs; rule 9 is about local trust marks (ACE / low integrity) that make a file demand a security confirmation after an agent touched it, plus the file-fd workaround for capturing child-process output inside the sandbox.

These rules are **general**. Host-specific measurements (the code page, PowerShell version, screen size, Defender state, certificate availability, the sandbox's exact ACEs) are examples from the machine where the rules were first derived — see [HOST-PROFILE.md](HOST-PROFILE.md). Re-measure them on a new host instead of assuming they match.

## How to resolve the bundled tools

When this skill is loaded, the harness reports a base directory, e.g.:

```
Base directory for this skill: <...>/node_modules/dsh-win-env-kit/skills/win-env-kit
Resolve relative paths mentioned by this skill against the base directory before using them.
```

That directory is the provider's `resourceBase`. **Every `tools/...` command below is relative to that base directory — call it `<SKILL_BASE>` — NOT to the workspace CWD.** Resolve it to an absolute path first:

```powershell
node "<SKILL_BASE>/tools/dsh-env-lint.mjs" .
node "<SKILL_BASE>/tools/build-audit.mjs" out\app.exe --strict
node "<SKILL_BASE>/tools/dsh-privacy-gate.mjs" "_scratch\*\shots\*.png" --strict
```

The `.` / `out\app.exe` / `_scratch\...` arguments still target the user's workspace. The scripts ship inside this package; do not expect a `tools/` directory in the workspace itself. All six scripts are dependency-free (node built-ins / PowerShell only) because the sandbox blocks `npm i` / `pip install`.

## 1. Text is UTF-8 without BOM; set it explicitly

Windows systems often default to a **legacy ANSI/OEM code page** (e.g. 936/GBK on Chinese installs, 1252 on Western ones). Anything that falls back to the system default produces legacy-encoded bytes, and the mojibake shows up one tool later. Detect the host with `chcp` and `python -c "import sys; print(sys.stdout.encoding, locale.getpreferredencoding())"`, then set the encoding explicitly everywhere.

| Surface | Make it UTF-8 |
|---|---|
| PowerShell read | `Get-Content -Encoding UTF8` |
| PowerShell write | `Set-Content -Encoding UTF8` (older 5.1 writes a BOM; see rule 2) |
| Python | `python -X utf8`, `open(..., encoding='utf-8')`, `sys.stdout.reconfigure(encoding='utf-8')` |
| Node | UTF-8 by default; `fs.writeFileSync(p, s, 'utf8')` to be explicit |
| git output | `git -c core.quotepath=false …` so non-ASCII paths stay readable |

**Done when** the bytes decode as UTF-8 with no `EF BF BD` and no runs of `0x3F`.

## 2. Line endings follow the file type

Default **LF**. Windows-native script formats take **CRLF**.

| Extensions | Ending |
|---|---|
| `.ps1 .psm1 .psd1 .bat .cmd .reg` | CRLF |
| `.ts .js .mjs .py .json .yml .yaml .md .txt .sh .toml .ini .cs .go .rs` | LF |
| `.exe .dll .png .zip .ico .pdf .woff2 .pdb` | untouched |

Three layers enforce it; the repo one is the durable one:

1. `.gitattributes` at the repo root — `* text=auto eol=lf`, then the CRLF list, then `binary` for artefacts. Template: [`.gitattributes.example`](.gitattributes.example) (copy it to the repo root and rename).
2. Global git: `git config --global core.autocrlf input`, `core.eol=lf`, `core.safecrlf=warn`. Verified behaviour: an LF file's index blob stays LF (CR=0), and a stray CRLF gets warned at `git add`, not silently rewritten.
3. `node "<SKILL_BASE>/tools/dsh-env-lint.mjs" <paths> --fix` before committing — normalises endings and strips BOM.

**Done when** `node "<SKILL_BASE>/tools/dsh-env-lint.mjs" .` exits 0.

### Two traps that produce wrong conclusions

- **Older Windows PowerShell (5.1) pipes and `>` redirects convert LF to CRLF.** Piping `git cat-file -p` can make a correct LF blob read back as CRLF and invert the verdict. Read raw line endings from bytes (`[System.IO.File]::ReadAllBytes`, or redirect via `cmd /c … > file`), never through a PowerShell pipeline.
- **A UTF-8 `.ps1` without BOM is read as the legacy code page by PowerShell 5.1**, mangling any non-ASCII literal inside it. Write non-ASCII `.ps1` as UTF-8 **with** BOM, or keep it pure ASCII.

`--fix` normalises endings and BOM only. Legacy-encoded files are reported (`GBKHEUR`, with the offending byte offset and hex) and left for an explicit `iconv`-style conversion, because guessing the source encoding can destroy the content.

## 3. Build output carries no machine identity

`%TEMP%` is frequently a per-run directory (under DSH it is `…\Temp\dsh-XXXXXX` and changes every run). A path baked into a binary is both non-reproducible and a familiar malware heuristic. Do not bake a username, machine name, or absolute temp path into a product.

- Build to an explicit output directory; keep paths relative to it.
- Generate directly in the target directory; the `Temp\dsh-*` → copy-out pattern leaves the temp path in the artefact.
- Sign with Authenticode **and** an RFC3161 timestamp. A timestamp is what keeps the signature valid after the certificate expires.
- Keep rebuilds reproducible: fixed paths, fixed timestamps, fixed ordering.

**Done when** `node "<SKILL_BASE>/tools/build-audit.mjs" <artefact>` reports no `TEMP-PATH`, `PE-DEBUG`, or `MOTW` finding.

## 4. SmartScreen is a reputation problem, not a policy problem

Detect the host's state rather than assuming it: check Defender (`Get-MpPreference` / `WinDefend` service), SmartScreen policy keys under `HKLM\…\Policies\Microsoft\Windows\System`, whether the edition has AppLocker, and whether a code-signing certificate exists in the `MY` store. On a box where Defender is disabled and no policy vets binaries, nothing local whitelists one — the reputation verdict comes from Microsoft's cloud when the recipient runs it. (Example measurements: [HOST-PROFILE.md](HOST-PROFILE.md).)

What actually moves the verdict:

- **Code-signing certificate** in the publisher's name, every release, with a timestamp. An unsigned binary always shows *Unknown publisher*. If no signing certificate is present, the first release needs one obtained and installed.
- **Consistent publisher identity** across releases — reputation accrues per certificate subject.
- **MOTW discipline on the distribution path.** A file that picks up a `Zone.Identifier` while downloading keeps it through unzip and repack, so the final exe arrives marked. Publish from a clean build directory; deliver via a link the user downloads from, not a re-zipped copy of a download.
- **Version resources**: `CompanyName`, `ProductName`, `FileVersion` set in the PE, plus a stable PDB name.
- **Prefer an installer** (MSI or a signed installer) over a bare rebuilt exe — installers carry a signable identity and avoid the "fresh exe from a temp path" shape.

**Done when** `node "<SKILL_BASE>/tools/build-audit.mjs" <artefact> --strict` exits 0, i.e. no `MOTW`, `SIGN`, `PE-DEBUG`, `TEMP-PATH`, or `PE-VERSION` finding.

## 5. Transient artefacts live only in `_scratch/`

Smoke tests, screenshots, probe scripts, one-off logs and temp data are the clutter that gets committed by accident. One isolation zone holds them all:

```
_scratch/<YYYY-MM-DD>-<topic>/{smoke,shots,probes,logs}/
```

- `.gitignore` excludes `_scratch/` permanently; `dsh-env-lint.mjs` puts `_scratch` in `SKIP_DIRS` so it never checks or fixes it; it never ships in a distributable.
- One task = one `<date>-<topic>/` directory. Delete it when the task ends. Promote something into `tests/` or `docs/` only when it has lasting value, then bring it under rules 1–2 (UTF-8/LF + lint) like any other source file.
- `dsh-env-lint.mjs` reports `SCRATCH` for a stray `screenshot*.png`, `smoke_test.*`, `probe*.py`, `shot-*.log` etc. found anywhere else in the tree — including a path passed explicitly.

**Done when** `node "<SKILL_BASE>/tools/dsh-env-lint.mjs" .` reports no `SCRATCH` finding and `git status` shows nothing under `_scratch/`.

## 6. Reading an image is an upload; gate it first

`read_image`, `present`, and pasting an image into the conversation send the pixels through the model service. A screenshot of the desktop therefore leaks the user's desktop. Run the gate **before** any of those tools:

```powershell
node "<SKILL_BASE>/tools/dsh-privacy-gate.mjs" "_scratch\<date>-<topic>\shots\shot-*.png" --strict
```

Only an `ALLOW` verdict permits reading the image into a conversation; `BLOCK` means leave it on disk. The gate is dependency-free and local — it parses file-header dimensions and scans the path plus image metadata bytes, never decoding pixels and never going online. It blocks on: a file outside `_scratch/` or `--root`; `PATH-PII`/`TEXT-PII` (username, machine name, `Temp\dsh-*`, `dsh-spill-*`, `Users\…\Desktop|Documents|Downloads`, `source\repos`); a `FULLSCREEN` size near the primary screen with no window attestation; `DIM-UNKNOWN` (fail-closed); and a `SCOPE` of `screen`. `--strict` also blocks `NO-SIDECAR` and `MAXIMIZED` (a maximized window still deserves a human look). The gate uses a conservative default full-screen floor; on a display with different dimensions override it with `--screen WxH` or the `DSH_SCREEN` environment variable (a sidecar's `screenW`/`screenH` is also honoured).

Capture with `<SKILL_BASE>/tools/dsh-screenshot.ps1` (pure ASCII, CRLF; P/Invoke into user32 + System.Drawing). If the host's `LocalMachine` execution policy is `RemoteSigned` and the DSH wrapper refuses unsigned local scripts, every invocation needs `-ExecutionPolicy Bypass`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_BASE>\tools\dsh-screenshot.ps1" -List
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_BASE>\tools\dsh-screenshot.ps1" -ProcessName notepad -Topic login
```

- It has **no full-screen mode**. `PrintWindow` renders the target window's own DC, so the desktop background, other apps and the taskbar never enter the bitmap. `-List` enumerates windows without capturing.
- Default output is `_scratch/<date>-<topic>/shots/shot-HHMMSS.png` plus a same-name `.json` sidecar recording `scope=window`, the clamped rect, and `screenW`/`screenH` — the proof the gate consumes.
- If `PrintWindow` returns a blank bitmap (common with GPU/Electron windows), the script falls back to `CopyFromScreen` over **the window rect only** and prints a `WARNING`: inspect the PNG locally for overlapping windows before letting it near a conversation.

Two traps worth remembering:

- **A window-sized PNG is not proof of a window-scoped capture.** A full-screen grab matches the physical or virtualized screen size, and a maximized window is close to either. That's why the sidecar's scope matters and why a near-fullscreen size plus attestation gets `MAXIMIZED` (manual review) rather than a clean pass. The gate's absolute floor cannot be inflated by a sidecar's `screenW/H`.
- **The gate runs on the path, not on your intent.** Passing a screenshot from `%TEMP%`, `Desktop`, or `Downloads` trips `LOCATION`/`PATH-PII` even if the pixels are harmless. Move it into `_scratch/` first.

**Done when** every image read into a conversation has a recorded `ALLOW` from `dsh-privacy-gate.mjs --strict`, and `_scratch/<date>-<topic>/` is deleted at task end.

## 7. Dev hygiene: log what you start, tear it down, and never loop on "gone"

The loop failure mode here is specific: after the user manually stops a test server or deletes a stray notes file, the agent keeps retrying `Get-Process` / `Read-File` forever, because "it existed a minute ago" is treated as "it should still be there." Two habits break it.

**Keep a ledger.** Any process you start or temp document you create for the task goes into `_scratch/<date>-<topic>/ledger.json`:

```json
{ "processes": [{ "pid": 1234, "cmd": "...", "purpose": "preview server", "startedAt": "ISO" }],
  "files": [{ "path": "_scratch/2026-11-06-foo/notes.md", "purpose": "scratch notes", "createdAt": "ISO" }] }
```

Record the **PID**, not the process name (many processes share a name). Process docs live only in `_scratch/` (rule 5 already excludes it from git and lint).

**Tear down at the end with `<SKILL_BASE>/tools/dsh-teardown.mjs`** (dependency-free):

```powershell
node "<SKILL_BASE>/tools/dsh-teardown.mjs" --rmdir        # kill ledger PIDs via taskkill /F /T, remove ledger files, remove the topic dir
```

The script reads the ledger, and for every entry treats *missing* as already-cleaned: a dead PID is `GONE` (info, no error, no retry), a missing file is `GONE`, a missing topic dir is simply skipped. Options: `--check` (probe once, no changes), `--dry` (print only), `--kill` / `--rm` individually. It refuses to delete anything outside `_scratch/`.

**The guardrail: gone ≠ error.** When a resource *you* created is now absent:

1. Verify once, then stop probing. Don't poll waiting for it to come back.
2. Default assumption: the user cleaned it up. Absence is a normal state, not a fault.
3. Only three moves: **re-create** it (if still needed), **skip** it (if not), or **treat as done** (if it was the deliverable).
4. Never loop: no repeated probe, no retry-storm, no "where did it go" spiral. Absent → pick one of the three → continue.

**Done when** `node "<SKILL_BASE>/tools/dsh-teardown.mjs" --rmdir` exits 0 and `git status` shows nothing under `_scratch/`. A `SCRATCH` finding from `dsh-env-lint.mjs` also catches stray `notes.md` / `draft` / `PROCESS` / `debug*.log` left in the source tree (rule 5 + this rule).

## 8. Multiple agents editing the same doc: claim a lock first

A second concurrent agent on `README.md` / `AGENTS.md` / `CHANGELOG` / a version file causes four failures: a later write silently overwrites an earlier one (read-modify-write race), edits interleave into duplicated headings or half-written sections, an encoding rewrite on a legacy-code-page + PowerShell 5.1 host injects a BOM or flips CRLF↔LF (so one agent's full rewrite mangles the whole file), and stale anchors make another agent's `edit` fail with `old_string not found`. DSH has no cross-agent file lock, so enforce **serialize + declare a lock** with `<SKILL_BASE>/tools/dsh-doc-lock.mjs` (dependency-free):

```powershell
node "<SKILL_BASE>/tools/dsh-doc-lock.mjs" claim   --file README.md --agent agentA --pid $pid --topic "install section" --ttl-min 30
node "<SKILL_BASE>/tools/dsh-doc-lock.mjs" check   --file README.md --agent agentB        # free|mine|expired|blocked
node "<SKILL_BASE>/tools/dsh-doc-lock.mjs" release --file README.md --agent agentA
```

The lock is a sibling `.<doc>.lock.json` (e.g. `.README.md.lock.json`); it holds `{agent, pid, since, expires, topic}`.

- **Single writer** is the strongest rule: only one agent (main thread, or one designated "doc writer" sub-agent) ever writes the file to disk. **Sub-agents return a diff/suggestion as text, they never write the shared file themselves.** That serializes writes at the source.
- `claim` returns exit 0 and grabs the lock when it's absent or expired; exit 1 (printing the holder) when a *fresh* lock belongs to someone else — add `--force` to take over a stale/orphaned lock. Your own fresh lock just renews.
- Always `release` after editing. Lock files match `*.lock.json`, already git-ignored, and `dsh-teardown.mjs --rmdir` sweeps any left in `_scratch/`.
- **Edit by section, not by whole-file rewrite.** Prefer `edit` point-replacements; split non-overlapping sections between agents (`## Install` vs `## API`). Re-read the current bytes right before writing, keep the file's existing encoding/BOM/line-endings, and run `dsh-env-lint.mjs --fix` at the end (idempotent, so multiple agents converge).

**Guardrail (gone ≠ error, applied to locks):** a missing lock file = nobody is editing = safe to enter, not a fault; an expired lock = the prior agent likely died/was interrupted = safe `--force` takeover, no error, no retry, no loop.

**Done when** every shared-doc edit is wrapped in `claim … release`, a `check` showing `blocked` makes the agent wait (once) or pick another section rather than race, and `git status` shows no `*.lock.json` tracked.

## 9. A file that starts demanding a security confirmation: local trust marks, not SmartScreen

Symptom: a script/command that used to open with a double-click begins asking for a security confirmation **after an agent created or edited it**. This is the same "trust" family as rule 4, but a different layer — rule 4 is Microsoft cloud reputation when a binary is distributed to *another* machine; this is a *local mark stamped on the file itself*. Don't reach for code signing to fix it.

Four mechanisms, in diagnosis order:

| Mechanism | Mark | Source | Fix |
|---|---|---|---|
| **A local trust mark (main cause)** | `S-1-4-*` ACE + `Low Mandatory Level` + `Everyone (DENY)` | DSH `workspace-write` sandbox stamps the workspace root; `(OI)(CI)` inherits it to **every** file inside | Generate/copy the artefact into a **clean directory outside the workspace root** |
| B MOTW | `Zone.Identifier` ADS (`ZoneId=3`) | download / download→unzip→repack | `Unblock-File`; agent-**authored** files don't get it |
| C execution policy | script `NotSigned` + `LocalMachine=RemoteSigned` | unsigned `.ps1` | per-call `-ExecutionPolicy Bypass` (rule 6) |
| D cloud reputation | no/expired Authenticode signature | distributing elsewhere | rule 4: Authenticode + RFC3161 |

Confirm A with `icacls <file>` on the workspace root: the confined sandbox typically adds three **explicit** (non-inherited) ACEs — an `S-1-4-*` restricting SID (non-unique authority, won't resolve to a user name), `Mandatory Label\Low Mandatory Level`, and `Everyone (DENY)` — and `(OI)(CI)` passes the restricting SID + Low IL to every file the agent creates under that root. Copying/generating into a clean directory outside that root **drops all three marks**; in-place repair is impossible from the confined token (`icacls … /setintegritylevel M` → `Access is denied.` / exit 5, `icacls … /remove *S-1-4-…` → exit 1332). **Do not hand-edit the ACL, delete deny entries, or change integrity; do not run `diagnose-windows-sandbox-acl`'s repair script** — that fixes unexpected *denials*, whereas this is an expected stamp. (Example ACEs: [HOST-PROFILE.md](HOST-PROFILE.md).)

Rules:

- Anything the user will double-click / execute / distribute: **don't finalise it in the workspace root**. Build in `_scratch/` or a clean directory outside the workspace, or `Copy-Item` to a clean dir before delivery (the copy loses the inherited marks).
- `node "<SKILL_BASE>/tools/build-audit.mjs" <artefact> --strict` also runs `icacls` for a **`TRUST-MARK`** finding (`S-1-4-*` / Low IL / Everyone DENY → high, exit 1). On a hit, move to a clean directory — do **not** fix the ACL. Directory mode scans PE + scripts + packages (`.exe/.ps1/.bat/.cmd/.msi/.zip/.iso/...`), not just PE.

**Done when** `node "<SKILL_BASE>/tools/build-audit.mjs" <final artefact in its delivery dir> --strict` reports no `TRUST-MARK` finding (and still no `MOTW`/`SIGN`/`TEMP-PATH`).

### Trap: capturing a child process's output inside the DSH sandbox

The confined sandbox **forbids capturing a child process's piped output**: `execFileSync` default pipes, `cmd /c … > file 2>&1`, and `powershell -Command` pipelines can all hit `spawnSync EPERM` (even `signtool.exe`). `stdio:'inherit'` runs but yields no output. The **only reliable pattern** is to point stdio directly at a **file fd** (not a named pipe), then read that file:

```js
const fd = openSync(dump, 'w');
execFileSync(bin, args, { stdio: ['ignore', fd, fd], timeout, windowsHide: true });
closeSync(fd);
const out = readFileSync(dump, 'utf8');  // strip a leading BOM and trailing \u0000 from PS 5.1 redirects
```

`<SKILL_BASE>/tools/build-audit.mjs` wraps this as `runCaptured()`; `readZoneIdentifier` / `readTrustMarks` / `verifySignature` / `readSignerInfo` all use it. **Any new tool that needs external command output must reuse `runCaptured`** — default pipes silently produce `null` / wrong verdicts in this sandbox. (This is also what fixed signature verification, which the EPERM had been silently breaking.)

## Verification commands

```powershell
node "<SKILL_BASE>/tools/dsh-env-lint.mjs" .                     # rules 1-2 + SCRATCH (rule 5)
node "<SKILL_BASE>/tools/dsh-env-lint.mjs" . --fix               # normalise endings + BOM
node "<SKILL_BASE>/tools/build-audit.mjs" out\app.exe --strict  # rules 3-4 + 9: MOTW / SIGN / TEMP-PATH / TRUST-MARK
node "<SKILL_BASE>/tools/build-audit.mjs" 'out\*' --json         # machine-readable; --strict counts mid too
node "<SKILL_BASE>/tools/dsh-privacy-gate.mjs" '_scratch\*\shots\*.png' --strict   # rule 6
```

`--strict` makes build-audit fail on mid findings as well as high; default exit 1 is high-only. A `TRUST-MARK` high finding means the artefact is still inside the stamped workspace root — regenerate it in a clean directory (rule 9), don't edit the ACL.

## Host profile

The measured values behind the "detect it" guidance above are recorded once in [HOST-PROFILE.md](HOST-PROFILE.md) as **examples, not requirements**. Re-measure on any new host; keep the detection regexes in the scripts (they are rules, not identity).
