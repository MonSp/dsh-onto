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

    # Seed ISSUED example packages into AML workspace (read-only consumption).
    $userHome = [Environment]::GetFolderPath('UserProfile')
    if (-not $userHome) { $userHome = $env:USERPROFILE }
    $wsPackages = Join-Path (Join-Path (Join-Path (Join-Path $userHome '.dsh\profiles') $ProfileName) 'dsh-onto') 'workspace\packages'
    $seedMap = @(
        @{ Src = 'aml'; Dst = 'aml-analysis' },
        @{ Src = 'med'; Dst = 'med-safety' },
        @{ Src = 'tax'; Dst = 'tax-risk' }
    )
    foreach ($s in $seedMap) {
        $src = Join-Path $RepoRoot "packages\$($s.Src)\1.0.0"
        $dst = Join-Path $wsPackages "$($s.Dst)\1.0.0"
        if ((Test-Path $src) -and -not (Test-Path $dst)) {
            New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
            Copy-Item -Recurse -Force $src $dst
            Write-Host "seeded $($s.Dst)@1.0.0"
        }
    }

    Write-Host ""
    Write-Host "AML profile '$ProfileName' ready (@dsh-aml/app only; no backend/workbench)."
    Write-Host "  Launch:  pnpm dsh --profile $ProfileName --no-open"
    Write-Host "  Assert:  scripts\dump-aml-config.ps1"
}
finally {
    Pop-Location
}
