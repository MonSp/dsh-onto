# Second-plugin config assertion: TAX profile has @dsh-tax/app, NOT backend/workbench.
param(
    [string]$HarnessDir = (Join-Path $PSScriptRoot '..\..\deepseek-harness'),
    [string]$ProfileName = 'dsh-tax'
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

if ($text -notmatch "dsh-tax-app|@dsh-tax/app") { $fail += 'MISSING @dsh-tax/app' }
else { Write-Host 'OK: @dsh-tax/app present' -ForegroundColor Green }

if ($text -match "dsh-onto-backend|@dsh-onto/backend") { $fail += 'UNEXPECTED @dsh-onto/backend in TAX profile' }
else { Write-Host 'OK: @dsh-onto/backend absent' -ForegroundColor Green }
if ($text -match "dsh-onto-workbench|@dsh-onto/workbench") { $fail += 'UNEXPECTED @dsh-onto/workbench in TAX profile' }
else { Write-Host 'OK: @dsh-onto/workbench absent' -ForegroundColor Green }

if ($text -notmatch "dsh-tax-app") { $fail += 'bundle insert id dsh-tax-app missing' }

if ($fail.Count -gt 0) {
    Write-Host ''
    Write-Host 'dump-tax-config FAILED:' -ForegroundColor Red
    $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

Write-Host ''
Write-Host 'dump-tax-config: OK — TAX present, backend/workbench absent' -ForegroundColor Green
exit 0
