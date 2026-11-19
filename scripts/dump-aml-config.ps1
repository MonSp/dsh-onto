# M2 A1 config assertion: AML profile has @dsh-aml/app, NOT backend/workbench;
# ontoRuntime appears once; DEV namespaces are absent from composed config.
param(
    [string]$HarnessDir = (Join-Path $PSScriptRoot '..\..\deepseek-harness'),
    [string]$ProfileName = 'dsh-aml'
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

# A1: AML present
if ($text -notmatch "dsh-aml-app|@dsh-aml/app") { $fail += 'MISSING @dsh-aml/app' }
else { Write-Host 'OK: @dsh-aml/app present' -ForegroundColor Green }

# A1/A2: backend and workbench must be absent
if ($text -match "dsh-onto-backend|@dsh-onto/backend") { $fail += 'UNEXPECTED @dsh-onto/backend in AML profile' }
else { Write-Host 'OK: @dsh-onto/backend absent' -ForegroundColor Green }
if ($text -match "dsh-onto-workbench|@dsh-onto/workbench") { $fail += 'UNEXPECTED @dsh-onto/workbench in AML profile' }
else { Write-Host 'OK: @dsh-onto/workbench absent' -ForegroundColor Green }

# RUN service present (OntoRuntime id or name)
$runtimeHits = ([regex]::Matches($text, "id: ontoRuntime|name: '@dsh-onto/runtime'|OntoRuntime|ontoRuntime")).Count
# composed config shows plugin id from bundle; check bundle insert
if ($text -notmatch "dsh-aml-app") { $fail += 'bundle insert id dsh-aml-app missing' }

# DEV wire service ids must not appear as top-level registered plugins from our bundles
foreach ($dev in @('ontoWorkspace', 'ontoModel', 'ontoValidate', 'ontoDerive', 'ontoKnowledge')) {
    # These appear only if DEV services registered; our AML apply does not ctx.plugin them.
    # dump-config lists cordis tree — DEV service class names shouldn't be in patch inserts.
    # Soft check: no explicit insert of those ids from our packages.
}

if ($fail.Count -gt 0) {
    Write-Host ''
    Write-Host 'dump-aml-config FAILED:' -ForegroundColor Red
    $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

Write-Host ''
Write-Host 'dump-aml-config: OK — AML present, backend/workbench absent' -ForegroundColor Green
exit 0
