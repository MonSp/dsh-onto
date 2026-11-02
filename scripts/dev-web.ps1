# Launch the caliber profile's Web UI from the source checkout.
param(
    [string]$HarnessDir = (Join-Path $PSScriptRoot '..\..\deepseek-harness'),
    [string]$ProfileName = 'caliber',
    [string[]]$ExtraArgs = @()
)

$ErrorActionPreference = 'Stop'
$HarnessDir = (Resolve-Path $HarnessDir).Path

Push-Location $HarnessDir
try {
    # dsh 裸命令默认即 Web UI（同 Investigator dev-web）；`--no-open` 经 ExtraArgs 透传。
    pnpm dsh --profile $ProfileName @ExtraArgs
}
finally {
    Pop-Location
}
