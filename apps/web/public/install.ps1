# Installs Momo on this Windows computer and starts it in the background (now,
# and whenever you sign in). Run in PowerShell:  irm <your Momo site>/install.ps1 | iex
# It needs the momo.env the setup page downloaded (looked for in Downloads).
# Nothing is installed system-wide: everything lives in %USERPROFILE%\.momo.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Dir = if ($env:MOMO_HOME) { $env:MOMO_HOME } else { Join-Path $env:USERPROFILE ".momo" }
$Repo = if ($env:MOMO_REPO) { $env:MOMO_REPO } else { "abaskabato/momo" }
$Ref = if ($env:MOMO_REF) { $env:MOMO_REF } else { "main" }
$Port = if ($env:PORT) { $env:PORT } else { "8787" }
function Say($m) { Write-Host $m -ForegroundColor Cyan }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# 1. Settings
$EnvFile = Join-Path $Dir "momo.env"
$Src = $env:MOMO_ENV
if ($env:MOMO_ENV_B64) {
  # The settings came inside the downloaded installer itself.
  $Src = Join-Path $Dir "momo.env.inline"
  [IO.File]::WriteAllBytes($Src, [Convert]::FromBase64String($env:MOMO_ENV_B64))
}
if (-not $Src) {
  $Downloads = Join-Path $env:USERPROFILE "Downloads"
  $Src = Get-ChildItem -Path $Downloads -Filter "momo*.env" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if ($Src) {
  $new = Get-Content $Src
  if (Test-Path $EnvFile) {
    # Keep the existing master key, or everything Momo saved would become unreadable.
    $keep = Get-Content $EnvFile | Where-Object { $_ -match '^MOMO_MASTER_KEY=' }
    if ($keep) { $new = @($new | Where-Object { $_ -notmatch '^MOMO_MASTER_KEY=' }) + $keep }
  }
  Set-Content -Path $EnvFile -Value $new -Encoding ascii
  Remove-Item $Src   # it holds your keys; the copy in .momo is the one Momo uses
  Say "Settings: saved to $EnvFile"
} elseif (Test-Path $EnvFile) {
  Say "Settings: keeping $EnvFile"
} else {
  throw "Couldn't find momo.env. Download it from the setup page first (it goes to your Downloads folder)."
}

# 2. Node.js 24+ (Momo's own copy unless you already have it)
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$Node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys -and [int](& node -p "process.versions.node.split('.')[0]") -ge 24) { $Node = $sys.Source }
elseif (Test-Path (Join-Path $Dir "node\node.exe")) { $Node = Join-Path $Dir "node\node.exe" }
else {
  Say "Downloading Node.js..."
  $Base = "https://nodejs.org/dist/latest-v24.x"
  $Sums = (Invoke-WebRequest "$Base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
  $Line = $Sums | Where-Object { $_ -match "node-v24\.[0-9.]+-win-$Arch\.zip$" } | Select-Object -First 1
  if (-not $Line) { throw "Couldn't find Node.js for win-$Arch." }
  $Want, $File = ($Line.Trim() -split '\s+')
  $Tmp = Join-Path $env:TEMP "momo-node-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  Invoke-WebRequest "$Base/$File" -OutFile "$Tmp\$File" -UseBasicParsing
  if ((Get-FileHash "$Tmp\$File" -Algorithm SHA256).Hash.ToLower() -ne $Want) { throw "Node.js download didn't verify." }
  Expand-Archive "$Tmp\$File" -DestinationPath $Tmp
  $NodeDir = Join-Path $Dir "node"
  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  Move-Item (Join-Path $Tmp ($File -replace '\.zip$', '')) $NodeDir
  Remove-Item -Recurse -Force $Tmp
  $Node = Join-Path $NodeDir "node.exe"
}
$NodeBin = Split-Path $Node
$env:PATH = "$NodeBin;$env:PATH"
$Npm = Join-Path $NodeBin "npm.cmd"

# 3. Momo
Say "Downloading Momo..."
$Tmp = Join-Path $env:TEMP "momo-app-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $Tmp | Out-Null
if ($env:MOMO_ZIP) { Copy-Item $env:MOMO_ZIP "$Tmp\momo.zip" }
else { Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Ref" -OutFile "$Tmp\momo.zip" -UseBasicParsing }
Expand-Archive "$Tmp\momo.zip" -DestinationPath $Tmp
$App = Join-Path $Dir "app"
# Stop every running Momo before replacing its files: two copies would fight over the same bot.
Stop-ScheduledTask -TaskName "Momo" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*packages*cloud*src*main.ts*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
if (Test-Path $App) { Remove-Item -Recurse -Force $App }
Move-Item (Get-ChildItem $Tmp -Directory | Select-Object -First 1).FullName $App
Remove-Item -Recurse -Force $Tmp
# When this copy was fetched; Momo prints it at startup so it's clear which version is running.
Set-Content -Path (Join-Path $App "VERSION") -Value (Get-Date -Format "yyyy-MM-dd HH:mm")
Say "Installing (a minute or two)..."
Push-Location $App
& $Npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error
if ($LASTEXITCODE) { throw "npm ci failed" }
Pop-Location
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $Dir "browsers"
& $Node (Join-Path $App "node_modules\playwright-core\cli.js") install chromium-headless-shell | Out-Null
$Tools = ""
if (Select-String -Path $EnvFile -Pattern '^MOMO_DESKTOP=local' -Quiet) {
  Say "Installing agent-desktop (so Momo can use apps on this screen)..."
  & $Npm install --prefix (Join-Path $Dir "tools") --no-audit --no-fund --no-update-notifier --loglevel=error agent-desktop | Out-Null
  $Tools = (Join-Path $Dir "tools\node_modules\.bin") + ";"
}

# 4. Start in the background, and at every sign-in
$Log = Join-Path $Dir "momo.log"
$Main = Join-Path $App "packages\cloud\src\main.ts"
$Cmd = Join-Path $Dir "momo.cmd"
@"
@echo off
set MOMO_HOME=$Dir
set PLAYWRIGHT_BROWSERS_PATH=$Dir\browsers
set PORT=$Port
set PATH=$Tools$NodeBin;%PATH%
"$Node" --env-file="$EnvFile" "$Main" >> "$Log" 2>&1
"@ | Set-Content -Path $Cmd -Encoding ascii
Set-Content -Path $Log -Value "" -Encoding ascii
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Cmd`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Momo" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Momo: text it, things get done" -Force | Out-Null
Start-ScheduledTask -TaskName "Momo"

# Momo holds this computer awake while it runs, except in a nightly maintenance window (03:00-05:00 unless
# momo.env says otherwise) when it may sleep, update or restart. This wakes it again when the window ends.
$Awake = (Get-Content $EnvFile | Where-Object { $_ -match '^MOMO_AWAKE=' } | Select-Object -Last 1) -replace '^MOMO_AWAKE=', ''
$Window = (Get-Content $EnvFile | Where-Object { $_ -match '^MOMO_MAINTENANCE=' } | Select-Object -Last 1) -replace '^MOMO_MAINTENANCE=', ''
if (-not $Window) { $Window = "03:00-05:00" }
$Rest = ""
Unregister-ScheduledTask -TaskName "Momo wake" -Confirm:$false -ErrorAction SilentlyContinue
if ($Awake -ne "off" -and $Window -match '^\s*\d{1,2}(:\d{2})?\s*-\s*(\d{1,2})(:(\d{2}))?\s*$') {
  try {
    $End = "{0:00}:{1:00}" -f [int]$Matches[2], [int]("0" + $Matches[4])
    $WakeAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c exit"
    $WakeTrigger = New-ScheduledTaskTrigger -Daily -At $End
    $WakeSettings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName "Momo wake" -Action $WakeAction -Trigger $WakeTrigger -Settings $WakeSettings -Description "Wakes this computer when Momo's maintenance window ends" -Force | Out-Null
    # Let scheduled tasks wake the computer while it's plugged in (Windows turns this off on some PCs).
    & powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 2>$null | Out-Null
    & powercfg /SETACTIVE SCHEME_CURRENT 2>$null | Out-Null
    $Rest = " Between $($Window -replace '\s*-\s*', ' and ') it may sleep or restart for updates, and wakes itself after."
  } catch {
    # Without the wake-up Momo would stay asleep after the window, so it keeps the computer awake through it instead.
    Add-Content -Path $EnvFile -Value "MOMO_MAINTENANCE=off" -Encoding ascii
    Restart-ScheduledTask -TaskName "Momo" -ErrorAction SilentlyContinue
  }
}

# 5. Wait for it to say hello
for ($i = 0; $i -lt 60; $i++) {
  if (Select-String -Path $Log -Pattern "Telegram: |iMessage: |Error" -Quiet) { break }
  Start-Sleep -Seconds 1
}
Write-Host ""
$hello = Select-String -Path $Log -Pattern "Telegram: |iMessage: " | Select-Object -Last 1
if ($hello) {
  Say "Momo is running."
  Write-Host $hello.Line.Trim()
  if ($Awake -eq "off") { Write-Host "Say hi to your bot. Leave this computer on: Momo works while it's awake." }
  else { Write-Host "Say hi to your bot. Momo keeps this computer awake so it can always answer: don't shut it down, and leave a laptop's lid open.$Rest" }
  Write-Host "Logs: $Log    Stop: Unregister-ScheduledTask Momo    Update: run this installer again"
} else {
  Write-Host "Momo didn't start cleanly. The last lines of its log ($Log):"
  Get-Content $Log -Tail 15
}
