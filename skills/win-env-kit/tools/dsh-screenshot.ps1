<#
.SYNOPSIS
Window-scoped screenshot for smoke / screenshot tests on this machine.
Pure ASCII, CRLF. Rule source: AGENTS.md section 7.

IMPORTANT: this script has NO full-screen mode by design. It captures ONE
window only. PrintWindow renders the target window's own device context, so
other applications, the desktop background, and the taskbar never enter the
bitmap. Use -Mode Rect only as a fallback for GPU-composited windows that
PrintWindow renders blank; that mode copies the window rectangle from the
screen and can include overlapping windows.

The companion .json sidecar records scope=window plus the rect and the
primary screen size, so tools/dsh-privacy-gate.mjs can prove the origin
BEFORE the image is read into a conversation (reading an image == upload).

.EXAMPLE
powershell -NoProfile -File tools\dsh-screenshot.ps1 -List
powershell -NoProfile -File tools\dsh-screenshot.ps1 -ProcessName notepad -Topic login-smoke
node tools/dsh-privacy-gate.mjs _scratch\2026-11-05-login-smoke\shots\shot-201530.png --strict
#>
[CmdletBinding()]
param(
  [string]$ProcessName,
  [string]$Title,
  [switch]$Foreground,
  [long]$Hwnd = 0,
  [string]$Out,
  [string]$Topic = 'smoke',
  [ValidateSet('Window', 'Rect')][string]$Mode = 'Window',
  [switch]$List
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$winSrc = @'
using System;
using System.Runtime.InteropServices;
public static class DshWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out DshRect lpRect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
[StructLayout(LayoutKind.Sequential)]
public struct DshRect { public int Left; public int Top; public int Right; public int Bottom; }
'@
Add-Type -TypeDefinition $winSrc
try { [DshWin]::SetProcessDPIAware() | Out-Null } catch { }

function Test-BlankBitmap {
  param([System.Drawing.Bitmap]$Bmp)
  $seen = @()
  for ($i = 1; $i -le 3; $i++) {
    for ($j = 1; $j -le 3; $j++) {
      $px = [int]($Bmp.Width * $i / 4)
      $py = [int]($Bmp.Height * $j / 4)
      if ($px -ge $Bmp.Width) { $px = $Bmp.Width - 1 }
      if ($py -ge $Bmp.Height) { $py = $Bmp.Height - 1 }
      $c = $Bmp.GetPixel($px, $py)
      $seen += "$($c.R),$($c.G),$($c.B)"
    }
  }
  return (($seen | Select-Object -Unique).Count -le 1)
}

# ---- -List: enumerate candidate windows. No capture, no upload. ----
if ($List) {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
    Sort-Object ProcessName |
    Select-Object Id, ProcessName, MainWindowHandle, MainWindowTitle |
    Format-Table -AutoSize
  return
}

# ---- resolve exactly one target window ----
$target = [IntPtr]::Zero
if ($Hwnd -ne 0) {
  $target = [IntPtr]$Hwnd
}
elseif ($Foreground) {
  $target = [DshWin]::GetForegroundWindow()
}
elseif ($ProcessName) {
  $p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $target = [IntPtr]$p.MainWindowHandle }
}
elseif ($Title) {
  $p = Get-Process -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Title*" } |
       Select-Object -First 1
  if ($p) { $target = [IntPtr]$p.MainWindowHandle }
}
else {
  throw 'Pick a window: -ProcessName / -Title / -Foreground / -Hwnd, or use -List to see them.'
}

if ($target -eq [IntPtr]::Zero) {
  throw 'No matching window found (or it has no main window handle). Use -List.'
}
if ([DshWin]::IsIconic($target)) {
  throw 'Target window is minimized. Restore it first.'
}

# ---- window rectangle, clamped to the primary screen ----
$rect = New-Object DshRect
if (-not [DshWin]::GetWindowRect($target, [ref]$rect)) { throw 'GetWindowRect failed.' }
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$screenW = $bounds.Width
$screenH = $bounds.Height

$srcX = $rect.Left;  if ($srcX -lt 0) { $srcX = 0 }
$srcY = $rect.Top;   if ($srcY -lt 0) { $srcY = 0 }
$srcX2 = $rect.Right;  if ($srcX2 -gt $screenW) { $srcX2 = $screenW }
$srcY2 = $rect.Bottom; if ($srcY2 -gt $screenH) { $srcY2 = $screenH }
$w = $srcX2 - $srcX
$h = $srcY2 - $srcY
if ($w -le 0 -or $h -le 0) { throw "Window rect is off-screen: $($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)" }

# ---- output path: _scratch/<date>-<topic>/shots/ by default ----
if ($Out) {
  $outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
}
else {
  $stamp = Get-Date -Format 'yyyy-MM-dd'
  $safeTopic = $Topic -replace '[^A-Za-z0-9._-]', '-'
  $dir = Join-Path (Join-Path (Join-Path (Get-Location).Path '_scratch') "$stamp-$safeTopic") 'shots'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $outPath = Join-Path $dir ('shot-' + (Get-Date -Format 'HHmmss') + '.png')
}
$outDir = Split-Path -Parent $outPath
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
if ([System.IO.Path]::GetExtension($outPath).ToLower() -ne '.png') {
  throw 'Only .png output is supported (the privacy gate parses PNG dimensions).'
}

# ---- capture ----
$bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$used = $Mode
$ok = $false
try {
  if ($Mode -eq 'Window') {
    $hdc = $g.GetHdc()
    try {
      # 0x2 = PW_RENDERFULLCONTENT (Windows 8.1+); needed for Chromium/Electron windows.
      $ok = [DshWin]::PrintWindow($target, $hdc, 2)
      if (-not $ok) { $ok = [DshWin]::PrintWindow($target, $hdc, 0) }
    }
    finally { $g.ReleaseHdc($hdc) }
    if ($ok -and (Test-BlankBitmap $bmp)) {
      # Uniform bitmap: the GPU window rendered nothing through PrintWindow.
      $ok = $false
    }
  }
  if (-not $ok) {
    $g.CopyFromScreen($srcX, $srcY, 0, 0, (New-Object System.Drawing.Size -ArgumentList $w, $h))
    $used = 'Rect'
  }
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
  $g.Dispose()
  $bmp.Dispose()
}

# ---- sidecar: proof of origin for dsh-privacy-gate.mjs ----
$sidePath = [System.IO.Path]::ChangeExtension($outPath, '.json')
$meta = [ordered]@{
  tool    = 'dsh-screenshot.ps1'
  scope   = 'window'
  mode    = $used
  hwnd    = [string]$target
  rect    = @($srcX, $srcY, $w, $h)
  screenW = $screenW
  screenH = $screenH
}
$json = $meta | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($sidePath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Saved   : $outPath"
Write-Host "Sidecar : $sidePath"
Write-Host "Scope   : window ($used)  rect=$srcX,$srcY,${w}x$h  screen=${screenW}x${screenH}"
if ($used -eq 'Rect') {
  Write-Host 'WARNING : PrintWindow returned blank; fell back to CopyFromScreen on the window rect. Overlapping windows may be visible - inspect before sharing.' -ForegroundColor Yellow
}
if ($w -ge $screenW * 0.9 -and $h -ge $screenH * 0.85) {
  Write-Host 'NOTE    : window covers most of the screen; the privacy gate will ask for manual review (MAXIMIZED).' -ForegroundColor Yellow
}
Write-Host "NEXT    : node tools/dsh-privacy-gate.mjs `"$outPath`" --strict"
