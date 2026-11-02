# Inspect the composed profile and hard-assert both @caliber/* packages
# are present. Missing any expected package exits non-zero.
param(
    [string]$HarnessDir = (Join-Path $PSScriptRoot '..\..\deepseek-harness'),
    [string]$ProfileName = 'caliber'
)

$ErrorActionPreference = 'Stop'

$Expected = @(
    '@caliber/backend',
    '@caliber/workbench'
)

$HarnessDir = (Resolve-Path $HarnessDir).Path

Push-Location $HarnessDir
try {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & pnpm dsh --profile $ProfileName --dump-config 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap

    if ($output) { $output | ForEach-Object { Write-Host $_ } }
    if ($exitCode -ne 0) { throw "dump-config failed for profile '$ProfileName' (exit $exitCode)" }

    $lines = @($output | ForEach-Object { "$_" })
}
finally {
    Pop-Location
}

function Test-CaliberPackage {
    param([string[]]$Lines, [string]$Pkg)
    $patterns = @(
        ("# == $Pkg"),
        ("name: '$Pkg'"),
        ("'$Pkg':")
    )
    foreach ($line in $Lines) {
        foreach ($pattern in $patterns) {
            if ($line.Contains($pattern)) { return $true }
        }
    }
    return $false
}

$missing = @()
$found = @()
foreach ($pkg in $Expected) {
    if (Test-CaliberPackage -Lines $lines -Pkg $pkg) { $found += $pkg }
    else { $missing += $pkg }
}

Write-Host ""
Write-Host ("dump-config: found {0}/{1} expected @caliber/* packages" -f $found.Count, $Expected.Count)
if ($missing.Count -eq 0) {
    Write-Host "dump-config: OK - all packages present" -ForegroundColor Green
    exit 0
}

Write-Host ("dump-config: MISSING {0} package(s):" -f $missing.Count) -ForegroundColor Red
foreach ($m in $missing) { Write-Host "  - $m" -ForegroundColor Red }
exit 1
