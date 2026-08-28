#Requires -Version 5.1
<#
.SYNOPSIS
  Portable silent installer/updater for official Vencord + Delexoo custom plugins.
  Paths come from SPYT_VENCORD_ROOT (default: %LOCALAPPDATA%\DelexooVencord).
#>

$ErrorActionPreference = "Stop"
$exitCode = 1

$InstallRoot = if ($env:SPYT_VENCORD_ROOT -and $env:SPYT_VENCORD_ROOT.Trim()) {
    $env:SPYT_VENCORD_ROOT.Trim()
} else {
    Join-Path $env:LOCALAPPDATA "DelexooVencord"
}

$ToolsDir = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path $InstallRoot "tools" }
$VencordDir = Join-Path $InstallRoot "Vencord"
$PluginsMirror = Join-Path $InstallRoot "vencord-plugins"
$EnvFile = Join-Path $InstallRoot ".env"
$LogFile = Join-Path $ToolsDir "update-vencord.log"
# Overlay every folder under src/userplugins (Delexo addons). Official plugins stay untouched.
$UpstreamUrl = "https://github.com/Vendicated/Vencord.git"
$PluginsRepo = "https://github.com/Delexoo/Vencord.git"
$AppDataDist = Join-Path $env:APPDATA "Vencord\dist"
$DiscordRoot = Join-Path $env:LOCALAPPDATA "Discord"

$env:GIT_ASK_YESNO = "false"
$env:GIT_TERMINAL_PROMPT = "0"
$env:SPYT_UPDATE_VENCORD_NO_PAUSE = "1"

New-Item -ItemType Directory -Force -Path $InstallRoot, $ToolsDir, $PluginsMirror | Out-Null

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    try { [Console]::Out.WriteLine($Message) } catch { }
}

function Get-GitHubToken {
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN.Trim() }
    $candidates = @(
        $EnvFile,
        (Join-Path $env:USERPROFILE "OneDrive\Desktop\Vencord\.env"),
        (Join-Path $env:USERPROFILE "Desktop\Vencord\.env")
    )
    foreach ($path in $candidates) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $line = Get-Content -LiteralPath $path | Where-Object { $_ -match '^\s*GITHUB_TOKEN\s*=' } | Select-Object -First 1
        if ($line) { return ($line -replace '^\s*GITHUB_TOKEN\s*=\s*', '').Trim() }
    }
    return $null
}

function Ensure-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name. Install Git, Node.js, and pnpm first."
    }
}

function Invoke-Native([string]$FileName, [string[]]$CmdArgs, [switch]$AllowFail) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $FileName @CmdArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($out) {
        foreach ($line in @($out)) {
            $text = "$line".TrimEnd()
            if ($text -and $text -notmatch '^System\.Management\.Automation\.RemoteException') {
                Write-Log $text
            }
        }
    }
    if (-not $AllowFail -and $code -ne 0) {
        throw "$FileName $($CmdArgs -join ' ') failed (exit $code)"
    }
    return $code
}

function Invoke-Git([string[]]$GitArgs) {
    [void](Invoke-Native "git.exe" $GitArgs)
}

function Remove-TreeForce([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    for ($i = 1; $i -le 6; $i++) {
        try {
            Get-ChildItem $Path -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
                try { $_.Attributes = "Normal" } catch { }
            }
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ($i -eq 6) {
                Write-Log "WARN: could not fully delete $Path ($($_.Exception.Message))"
                return
            }
            Start-Sleep -Milliseconds (500 * $i)
        }
    }
}

function Invoke-GitCleanNonInteractive {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "git.exe"
    $psi.Arguments = "clean -fd --exclude=node_modules --exclude=dist"
    $psi.WorkingDirectory = (Get-Location).Path
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.WriteLine("n")
    $p.StandardInput.WriteLine("n")
    $p.StandardInput.WriteLine("n")
    $p.StandardInput.Close()
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    [void]$p.WaitForExit(120000)
    if ($stdout) { Write-Log $stdout.Trim() }
    if ($stderr) {
        $filtered = ($stderr -split "`r?`n" | Where-Object {
            $_ -and ($_ -notmatch "Should I try again") -and ($_ -notmatch "Deletion of directory")
        }) -join "`n"
        if ($filtered) { Write-Log $filtered }
    }
}

function Stop-DiscordFully {
    Write-Log "Closing Discord..."
    foreach ($n in @("Discord", "DiscordCanary", "DiscordPTB", "DiscordDevelopment")) {
        Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "*\Discord\*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 20; $i++) {
        $left = @(Get-Process -Name Discord,DiscordCanary,DiscordPTB -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) { break }
        Start-Sleep -Milliseconds 400
        $left | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
    Write-Log "Discord closed."
}

function Start-DiscordApp {
    Write-Log "Starting Discord..."
    $updateExe = Join-Path $DiscordRoot "Update.exe"
    if (Test-Path $updateExe) {
        Start-Process -FilePath $updateExe -ArgumentList "--processStart", "Discord.exe"
        Write-Log "Launched via Update.exe"
        return
    }
    $appDirs = Get-ChildItem -Path $DiscordRoot -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
    foreach ($dir in $appDirs) {
        $exe = Join-Path $dir.FullName "Discord.exe"
        if (Test-Path $exe) {
            Start-Process -FilePath $exe
            Write-Log "Launched $exe"
            return
        }
    }
    Write-Log "WARN: could not find Discord.exe to relaunch"
}

function Ensure-VencordRepo {
    if (Test-Path (Join-Path $VencordDir ".git")) { return }
    Write-Log "Cloning official Vencord from https://github.com/Vendicated/Vencord"
    $parent = Split-Path $VencordDir -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (Test-Path $VencordDir) { Remove-TreeForce $VencordDir }
    Invoke-Git @("clone", "--origin", "origin", $UpstreamUrl, $VencordDir)
    Push-Location $VencordDir
    try {
        if (@(git remote) -notcontains "upstream") {
            Invoke-Git @("remote", "add", "upstream", $UpstreamUrl)
        }
    } finally {
        Pop-Location
    }
}

try {
    Set-Content -LiteralPath $LogFile -Value "" -Encoding UTF8
    Write-Log "Installer/updater started"
    Write-Log "InstallRoot=$InstallRoot"
    Write-Log "Vencord=$VencordDir"

    Ensure-Command git
    Ensure-Command node
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue) -and -not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) {
        throw "Missing required command: pnpm. Install with: npm install -g pnpm"
    }

    $token = Get-GitHubToken
    if ($token) {
        $env:GH_TOKEN = $token
        $env:GITHUB_TOKEN = $token
    }

    Stop-DiscordFully
    Ensure-VencordRepo

    $tmp = $null
    Push-Location $VencordDir
    try {
        $remotes = @(git remote)
        # Origin must be official Vencord. Pointing it at Delexoo makes the in-app
        # updater think there are always updates (fork commits on top of HEAD).
        if ($remotes -contains "origin") {
            Invoke-Git @("remote", "set-url", "origin", $UpstreamUrl)
        } else {
            Invoke-Git @("remote", "add", "origin", $UpstreamUrl)
        }
        if ($remotes -notcontains "upstream") {
            Invoke-Git @("remote", "add", "upstream", $UpstreamUrl)
        } else {
            Invoke-Git @("remote", "set-url", "upstream", $UpstreamUrl)
        }

        Write-Log "Fetching official Vendicated/Vencord"
        Invoke-Git @("fetch", "origin", "--prune")
        [void](Invoke-Native "git.exe" @("fetch", "upstream", "--prune") -AllowFail)
        Invoke-Git @("checkout", "main")
        Remove-TreeForce (Join-Path $VencordDir "src\userplugins")
        Invoke-Git @("reset", "--hard", "origin/main")
        Invoke-GitCleanNonInteractive
        [void](Invoke-Native "git.exe" @("branch", "--set-upstream-to=origin/main", "main") -AllowFail)

        Write-Log "Pulling plugins from Delexoo/Vencord"
        $tmp = Join-Path $env:TEMP ("vencord-plugins-" + [guid]::NewGuid().ToString("n"))
        $pulled = $false
        try {
            $cloneUrl = if ($token) {
                "https://x-access-token:${token}@github.com/Delexoo/Vencord.git"
            } else {
                $PluginsRepo
            }
            $cloneCode = Invoke-Native "git.exe" @(
                "clone", "--depth", "1", "--filter=blob:none", "--sparse", $cloneUrl, $tmp
            ) -AllowFail
            if ($cloneCode -eq 0) {
                Push-Location $tmp
                try {
                    # Cone mode only accepts directories (not single .tsx files).
                    $sparseCode = Invoke-Native "git.exe" @(
                        "sparse-checkout", "set",
                        "src/userplugins"
                    ) -AllowFail
                    if ($sparseCode -eq 0 -and (Test-Path (Join-Path $tmp "src\userplugins"))) {
                        $pulled = $true
                    } else {
                        Write-Log "WARN: sparse-checkout failed (exit $sparseCode)"
                    }
                } finally {
                    Pop-Location
                }
            }
        } catch {
            Write-Log "GitHub plugin pull failed - $($_.Exception.Message)"
        }

        $fallbackRoots = @(
            (Join-Path $env:USERPROFILE "OneDrive\Desktop\SpyT\vencord-plugins"),
            (Join-Path $env:USERPROFILE "Desktop\SpyT\vencord-plugins"),
            (Join-Path $env:USERPROFILE "OneDrive\Desktop\Vencord\src\userplugins"),
            (Join-Path $env:USERPROFILE "Desktop\Vencord\src\userplugins"),
            $PluginsMirror
        )

        $sourceRoot = $null
        if ($pulled) {
            $sourceRoot = Join-Path $tmp "src\userplugins"
            Write-Log "Using GitHub plugin source $sourceRoot"
        } else {
            foreach ($candidate in $fallbackRoots) {
                $probe = Join-Path $candidate "audioCapture"
                if (Test-Path -LiteralPath $probe) {
                    $sourceRoot = $candidate
                    Write-Log "Using fallback plugin source $sourceRoot"
                    break
                }
            }
        }

        if (-not $sourceRoot -or -not (Test-Path -LiteralPath $sourceRoot)) {
            throw "No plugin source found. Clone failed and no local mirror at $PluginsMirror (or Desktop SpyT/Vencord)."
        }

        $destRoot = Join-Path $VencordDir "src\userplugins"
        New-Item -ItemType Directory -Force -Path $destRoot, $PluginsMirror | Out-Null

        $overlayed = 0
        $pluginDirs = @(Get-ChildItem -LiteralPath $sourceRoot -Directory -Force | Where-Object { $_.Name -notmatch '^\.' })
        foreach ($dir in $pluginDirs) {
            $name = $dir.Name
            $from = $dir.FullName
            $to = Join-Path $destRoot $name
            $mirror = Join-Path $PluginsMirror $name
            if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
            if (Test-Path -LiteralPath $mirror) { Remove-Item -LiteralPath $mirror -Recurse -Force }
            Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
            Copy-Item -LiteralPath $from -Destination $mirror -Recurse -Force
            Get-ChildItem -LiteralPath $to, $mirror -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            Write-Log "Overlayed plugin $name"
            $overlayed++
        }
        if ($overlayed -lt 1) {
            throw "No plugins were overlayed from $sourceRoot"
        }
        Write-Log "Official Vencord left untouched. Delexo plugins are addons only."
    } finally {
        Pop-Location
        if ($tmp -and (Test-Path $tmp)) {
            Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Push-Location $VencordDir
    try {
        Write-Log "pnpm install"
        $pnpmCode = Invoke-Native "cmd.exe" @("/c", "pnpm", "install", "--frozen-lockfile") -AllowFail
        if ($pnpmCode -ne 0) {
            $pnpmCode = Invoke-Native "cmd.exe" @("/c", "pnpm", "install") -AllowFail
            if ($pnpmCode -ne 0) { throw "pnpm install failed" }
        }

        Write-Log "pnpm build"
        # Keep Delexo plugins in the Discord bundle. Official in-app updates would replace dist.
        $buildCode = Invoke-Native "cmd.exe" @("/c", "pnpm", "build", "--disable-updater") -AllowFail
        if ($buildCode -ne 0) { throw "pnpm build failed" }

        Write-Log "Running installer"
        [void](Invoke-Native "node.exe" @("scripts/runInstaller.mjs", "--", "--install", "--branch", "auto") -AllowFail)

        Write-Log "Copying build to AppData"
        New-Item -ItemType Directory -Force -Path $AppDataDist | Out-Null
        $distDir = Join-Path $VencordDir "dist"
        foreach ($f in @(
                "package.json",
                "renderer.js", "renderer.css", "renderer.js.map", "renderer.css.map", "renderer.js.LEGAL.txt",
                "preload.js", "preload.js.map",
                "patcher.js", "patcher.js.map", "patcher.js.LEGAL.txt",
                "vencordDesktopMain.js", "vencordDesktopMain.js.map", "vencordDesktopMain.js.LEGAL.txt",
                "vencordDesktopPreload.js", "vencordDesktopPreload.js.map",
                "vencordDesktopRenderer.js", "vencordDesktopRenderer.js.map", "vencordDesktopRenderer.css",
                "vencordDesktopRenderer.js.LEGAL.txt"
            )) {
            $src = Join-Path $distDir $f
            if (Test-Path $src) {
                Copy-Item $src (Join-Path $AppDataDist $f) -Force
            }
        }
    } finally {
        Pop-Location
    }

    Start-DiscordApp
    Write-Log "Done successfully"
    $exitCode = 0
} catch {
    Write-Log "FAILED: $($_.Exception.Message)"
    $exitCode = 1
}

exit $exitCode
