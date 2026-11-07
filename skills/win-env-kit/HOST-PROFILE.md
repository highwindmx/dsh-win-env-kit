# Host profile — example measurements (not requirements)

> **These are measurements from the single Windows host where these rules were
> first derived. They are examples, NOT requirements, and they will be wrong on
> most other machines.** `SKILL.md` deliberately avoids baking them into the
> rules: detect each value on the machine you are actually working on. This file
> is kept so a reader can see what a real "measured" run looked like, and so no
> identity leaks into the skill body that the model loads.

Nothing here should be copied into a build product. It is reference only.

## Code page and shell

- System ANSI/OEM code page: **936 (GBK)**. `chcp` → `936`; `python -c "import sys,locale; print(sys.stdout.encoding, locale.getpreferredencoding())"` → `gbk cp936`.
- Host shell for the DSH terminal: **Windows PowerShell 5.1** (not pwsh 7).
- PowerShell 5.1 reads a BOM-less UTF-8 `.ps1` as GBK; a pipe or `>` redirect converts LF → CRLF.

## Build / trust environment

- OS: **Windows 10 Home China, build 26300**.
- Defender **disabled**: `DisableAntiSpyware=1`, `WinDefend` service stopped; SmartScreen policy keys under `HKLM\…\Policies\Microsoft\Windows\System` empty; Home edition has no AppLocker.
- No code-signing certificate: the `MY` store holds only a `CN=localhost` test cert.
- `%TEMP%` is a per-run `…\Temp\dsh-XXXXXX` directory (changes every run).

## Display

- Primary screen: **1280x800 logical / 1920x1200 physical** (150% scaling). A DPI-unaware process (including the DSH host) sees the virtualized 1280x800; `dsh-screenshot.ps1` calls `SetProcessDPIAware()` so its sidecar reports 1920x1200.
- `Get-CimInstance Win32_VideoController` fails here with `无法从客户端中访问 CIM 资源。` — don't rely on it. The privacy gate treats both sizes as full-screen suspects.

## Sandbox trust marks (ACE / low integrity) — the concrete example

- Workspace root: `D:\Share\Scripts\Explore\useAI\DSH` carried three **explicit** (non-inherited) ACEs:
  - `S-1-4-415621802-122513890:(OI)(CI)(W,D,DC)`
  - `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`
  - `Everyone:(CI)(DENY)(DC)`
- `(OI)(CI)` passes `S-1-4-*` + Low IL to every agent-created file under that root. The `S-1-4-*` restricting SID is non-unique authority and does not resolve to a user name.
- Copying/generating into a clean directory outside that root drops all three marks (verified: the parent dir keeps only Administrators/SYSTEM/Authenticated Users/Users).
- In-place repair from the confined token is impossible: `icacls <f> /setintegritylevel M` → `Access is denied.` (exit 5); `icacls <f> /remove *S-1-4-…` → exit 1332.

## DSH sandbox child-process output

- `execFileSync` default pipes / `cmd /c … > file 2>&1` / `powershell -Command` pipelines hit `spawnSync EPERM` here (even `signtool.exe`). `stdio:'inherit'` runs but yields no output. The file-fd `runCaptured()` pattern in `tools/build-audit.mjs` is the workaround.

## How to re-measure on a new host

| Value | Probe |
|---|---|
| Code page | `chcp` |
| PowerShell version | `$PSVersionTable.PSVersion` |
| Defender / SmartScreen | `Get-MpPreference`, the `WinDefend` service, `HKLM\…\System` policy keys |
| Signing cert | `Get-ChildItem Cert:\CurrentUser\My` (or `LocalMachine\My`) |
| Screen size | `dsh-screenshot.ps1 -List` sidecar `screenW`/`screenH`, or `--screen WxH` / `DSH_SCREEN` |
| Trust marks | `icacls <workspace-root>` |
| Temp dir shape | `echo %TEMP%` across two runs |

Keep the detection regexes in the bundled scripts (`S-1-4-\d`, `Temp\dsh-`, `dsh-spill-`): they are **rules**, not this host's identity.
