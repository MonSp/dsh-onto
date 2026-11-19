# Create (or reset) the `dsh-aml` dsh profile with ONLY @dsh-aml/app
# (no @dsh-onto/backend / @dsh-onto/workbench) — M2 A1 clean AML profile.
param(
    [string]$HarnessDir = (Join-Path $PSScriptRoot '..\..\deepseek-harness'),
    [string]$ProfileName = 'dsh-aml',
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'

$HarnessDir = (Resolve-Path $HarnessDir).Path
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$AmlBundle = Join-Path $RepoRoot 'apps\aml'

Push-Location $HarnessDir
try {
    if ($Reset) {
        pnpm dsh --profile $ProfileName --from-default-profile web --dump-config | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "failed to reset profile '$ProfileName'" }
    }
    else {
        $profileDir = Join-Path (Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles') $ProfileName
        if (-not (Test-Path $profileDir)) {
            pnpm dsh --profile $ProfileName --from-default-profile web --dump-config | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "failed to create profile '$ProfileName'" }
        }
    }

    # runtime deps first (AML depends on link:../runtime)
    foreach ($pkg in @('core', 'runtime', (Join-Path 'apps' 'aml'))) {
        Push-Location (Join-Path $RepoRoot $pkg)
        try {
            pnpm install
            if ($LASTEXITCODE -ne 0) { throw "pnpm install failed: $pkg" }
            pnpm run build
            if ($LASTEXITCODE -ne 0) { throw "build failed: $pkg" }
        }
        finally { Pop-Location }
    }

    Push-Location $HarnessDir
    try {
        pnpm dsh plugin --profile $ProfileName add $AmlBundle
        if ($LASTEXITCODE -ne 0) { throw "failed to install @dsh-aml/app into '$ProfileName'" }
    }
    finally { Pop-Location }

    Write-Host ""
    Write-Host "AML profile '$ProfileName' ready (@dsh-aml/app only; no backend/workbench)."
    Write-Host "  Runs require an issued release imported and activated by an authorized operator."
    Write-Host "  Launch:  pnpm dsh --profile $ProfileName --no-open"
    Write-Host "  Assert:  scripts\dump-aml-config.ps1"
}
finally {
    Pop-Location
}
