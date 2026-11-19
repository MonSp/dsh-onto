# Create (or reset) the `dsh-tax` dsh profile with ONLY @dsh-tax/app
# (no @dsh-onto/backend / @dsh-onto/workbench) — second-plugin cold-start profile.
param(
    [string]$HarnessDir = (Join-Path $PSScriptRoot '..\..\deepseek-harness'),
    [string]$ProfileName = 'dsh-tax',
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'

$HarnessDir = (Resolve-Path $HarnessDir).Path
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TaxBundle = Join-Path $RepoRoot 'apps\tax'

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

    # runtime deps first (TAX depends on link:../runtime)
    foreach ($pkg in @('core', 'runtime', (Join-Path 'apps' 'tax'))) {
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
        pnpm dsh plugin --profile $ProfileName add $TaxBundle
        if ($LASTEXITCODE -ne 0) { throw "failed to install @dsh-tax/app into '$ProfileName'" }
    }
    finally { Pop-Location }

    Write-Host ""
    Write-Host "TAX profile '$ProfileName' ready (@dsh-tax/app only; no backend/workbench)."
    Write-Host "  Seed release:  node scripts\m-tax-seed-release.mjs"
    Write-Host "  Data source:   set DSH_TAX_API_URL=http://127.0.0.1:3911 before launch"
    Write-Host "  Identity:      set DSH_BIZ_USER_ID / DSH_BIZ_TENANT / DSH_BIZ_ROLES (e.g. analyst)"
    Write-Host "  Launch:  pnpm dsh --profile $ProfileName --no-open"
    Write-Host "  Assert:  scripts\dump-tax-config.ps1"
}
finally {
    Pop-Location
}
