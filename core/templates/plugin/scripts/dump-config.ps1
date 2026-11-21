# Composition assertion: profile has __PKG_ID__, no backend/workbench (api-to-plugin S2.8).
param(
    [string]$HarnessDir = '__HARNESS_DIR__',
    [string]$ProfileName = '__PROFILE_NAME__'
)

$ErrorActionPreference = 'Stop'
$HarnessDir = (Resolve-Path $HarnessDir).Path

Push-Location $HarnessDir
try {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & pnpm dsh --profile $ProfileName --dump-config 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($output) { $output | ForEach-Object { Write-Host $_ } }
    if ($exitCode -ne 0) { throw "dump-config failed for '$ProfileName' (exit $exitCode)" }
    $text = ($output | ForEach-Object { "$_" }) -join "`n"
}
finally {
    Pop-Location
}

$fail = @()

if ($text -notmatch "__PLUGIN_INSERT_ID__|__PKG_ID__") { $fail += 'MISSING __PKG_ID__' }
else { Write-Host 'OK: __PKG_ID__ present' -ForegroundColor Green }

if ($text -match "dsh-onto-backend|@dsh-onto/backend") { $fail += 'UNEXPECTED @dsh-onto/backend' }
else { Write-Host 'OK: @dsh-onto/backend absent' -ForegroundColor Green }
if ($text -match "dsh-onto-workbench|@dsh-onto/workbench") { $fail += 'UNEXPECTED @dsh-onto/workbench' }
else { Write-Host 'OK: @dsh-onto/workbench absent' -ForegroundColor Green }

if ($fail.Count -gt 0) {
    Write-Host ''
    Write-Host 'dump-config FAILED:' -ForegroundColor Red
    $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

Write-Host ''
Write-Host 'dump-config: OK — __PKG_ID__ present, backend/workbench absent' -ForegroundColor Green
exit 0
