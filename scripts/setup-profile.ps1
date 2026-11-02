# Create (or reset) the `caliber` dsh profile from the shipped `web`
# template and install the @caliber/backend + @caliber/workbench bundles,
# then seed the workspace with the example business ontology packages.
#
# Run from anywhere; requires the deepseek-harness source checkout at
# $HarnessDir with dependencies installed (pnpm install + pnpm run build).
param(
    [string]$HarnessDir = (Join-Path $PSScriptRoot '..\..\deepseek-harness'),
    [string]$ProfileName = 'caliber',
    # Reset wipes any user patches previously added to the profile.
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'

$HarnessDir = (Resolve-Path $HarnessDir).Path
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Bundles = @(
    (Join-Path $RepoRoot 'backend'),
    (Join-Path $RepoRoot 'workbench')
)

Push-Location $HarnessDir
try {
    if ($Reset) {
        pnpm dsh --profile $ProfileName --from-default-profile web --dump-config | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "failed to reset profile '$ProfileName' from the web template" }
    }
    else {
        $profileDir = Join-Path (Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles') $ProfileName
        if (-not (Test-Path $profileDir)) {
            pnpm dsh --profile $ProfileName --from-default-profile web --dump-config | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "failed to create profile '$ProfileName' from the web template" }
        }
    }

    # core 引擎先行（backend 依赖 link:../core 的 dist）
    Push-Location (Join-Path $RepoRoot 'core')
    try {
        pnpm install
        if ($LASTEXITCODE -ne 0) { throw "failed to install dependencies for 'core'" }
        pnpm run build
        if ($LASTEXITCODE -ne 0) { throw "failed to build 'core'" }
    }
    finally { Pop-Location }

    foreach ($bundle in $Bundles) {
        Push-Location $bundle
        try {
            pnpm install
            if ($LASTEXITCODE -ne 0) { throw "failed to install dependencies for '$bundle'" }
            pnpm run build
            if ($LASTEXITCODE -ne 0) { throw "failed to build bundle '$bundle'" }
        }
        finally { Pop-Location }

        Push-Location $HarnessDir
        try {
            pnpm dsh plugin --profile $ProfileName add $bundle
            if ($LASTEXITCODE -ne 0) { throw "failed to install bundle '$bundle' into profile '$ProfileName'" }
        }
        finally { Pop-Location }
    }

    # 播种示例业务本体包（域目录 → 包名目录）；目录解析多级回退，失败不阻断装配
    $userHome = [Environment]::GetFolderPath('UserProfile')
    if (-not $userHome) { $userHome = $HOME }
    if (-not $userHome) { $userHome = $env:USERPROFILE }
    if (-not $userHome) {
        Write-Host "seed skipped: cannot resolve user home; copy packages/* manually into <profile>/caliber/workspace/packages/" -ForegroundColor Yellow
    }
    else {
        $profilesRoot = Join-Path $userHome '.dsh\profiles'
        $dataDir = Join-Path (Join-Path $profilesRoot $ProfileName) 'caliber'
        $wsPackages = Join-Path $dataDir 'workspace\packages'
        $seedMap = @(
            @{ Src = 'aml'; Dst = 'aml-analysis' },
            @{ Src = 'med'; Dst = 'med-safety' }
        )
        foreach ($s in $seedMap) {
            $src = Join-Path $RepoRoot "packages\$($s.Src)\1.0.0"
            $dst = Join-Path $wsPackages "$($s.Dst)\1.0.0"
            if ((Test-Path $src) -and -not (Test-Path $dst)) {
                New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
                Copy-Item -Recurse -Force $src $dst
                Write-Host "seeded example package $($s.Dst)@1.0.0"
            }
        }
    }

    Write-Host ""
    Write-Host "Profile '$ProfileName' is ready (@caliber/backend + @caliber/workbench)."
    Write-Host "  Launch:  scripts\dev-web.ps1"
    Write-Host "  Inspect: pnpm dsh --profile $ProfileName --dump-config"
}
finally {
    Pop-Location
}
