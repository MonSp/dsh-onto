# 受控部署链（api-to-plugin）：构建 -> 回放锚定 -> 装 profile -> 导入 + 人工激活 -> 组合断言 -> 受控重启 -> 双入口验收锚。
# 只管理本插件 profile 的宿主（-Restart 仅重启 -Port 上的目标宿主），不触碰其他 profile / 平台宿主。
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -AuthorizedBy "..." -Restart -Port 3081 -EnvFile .env
# 前提：PATH 上有受支持的 node 与 pnpm（宿主启动同口径）。
param(
    [string]$AuthorizedBy = '',
    [switch]$SkipBuild,
    [switch]$Restart,
    [int]$Port = 0,
    [string]$EnvFile = '',
    [string]$Data = '',
    [string]$HarnessDir = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Config = Get-Content (Join-Path $Root 'plugin.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json

if ($HarnessDir -eq '') { $HarnessDir = $Config.harnessDir }
$CoreDir    = $Config.coreDir
$RuntimeDir = $Config.runtimeDir
$PackageDir = $Config.packageDir
$ScenarioId = $Config.scenarioId
$SourceId   = $Config.sourceId
$isDataset  = ($Config.dataMode -eq 'dataset')
$Profile    = $Config.profileName
$PkgName    = $Config.packageName
$PkgVersion = $Config.packageVersion
$ApiEnvName = $Config.env.apiUrl

function Step([string]$msg) { Write-Host ''; Write-Host ('==> ' + $msg) -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host ('FAILED: ' + $msg) -ForegroundColor Red; exit 1 }

# 信任边界：plugin.config.json 是生成期数据（跨人交接），不是代码。
# profile 名进入命令行/进程匹配，限定安全字符集；harness 路径进入 -Command 时按单引号转义。
if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    Fail ('profileName 含非法字符（仅允许 [A-Za-z0-9._-]）: ' + $Profile)
}
if (-not (Test-Path -LiteralPath $HarnessDir)) {
    Fail ('harnessDir 不存在: ' + $HarnessDir)
}

# 0) optional deploy env file (KEY=VALUE lines; applies to this chain and the target host process)
if ($EnvFile -ne '') {
    if (-not (Test-Path $EnvFile)) { Fail ('EnvFile not found: ' + $EnvFile) }
    $blockedKeys = @('NODE_OPTIONS','NODE_PATH','PATH','PATHEXT','COMSPEC','PSModulePath','POWERSHELL_UPDATECHECK')
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $kv = $line -split '=', 2
        if ($kv.Count -ne 2) { Fail ('EnvFile 行须是 KEY=VALUE: ' + $line) }
        $k = $kv[0].Trim()
        if ($k -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { Fail ('EnvFile 键名非法: ' + $k) }
        if ($blockedKeys -contains $k) { Fail ('EnvFile 键被拒绝（可注入进程启动链）: ' + $k) }
        Set-Item -Path ('Env:' + $k) -Value $kv[1].Trim()
    }
    Write-Host ('env loaded from ' + $EnvFile)
}

# 1) build + fixture e2e (fixture -> scenario, score idempotency)
if (-not $SkipBuild) {
    Step 'build + fixture e2e'
    Push-Location $Root
    try {
        pnpm install; if ($LASTEXITCODE -ne 0) { Fail 'pnpm install' }
        pnpm run build; if ($LASTEXITCODE -ne 0) { Fail 'build' }
        node --test tests/*.test.mjs; if ($LASTEXITCODE -ne 0) { Fail 'fixture e2e tests' }
    } finally { Pop-Location }
}

# 2) replay anchor: packaged fixture -> mapping -> scenario vs packaged baseline (fingerprinted; drift is rejected)
#    dataset 模式（纯内容包）无映射链，跳过回放锚；验收锚改由步骤 7 的夹具 live run 提供。
if (-not $isDataset) {
    Step ('replay --check ' + $ScenarioId)
    node (Join-Path $CoreDir 'dist/cli.js') replay --dir $PackageDir --scenario $ScenarioId --check
    if ($LASTEXITCODE -ne 0) { Fail 'replay --check (baseline drift or replay failure)' }
} else {
    Step 'replay anchor skipped (dataset mode: no mapping chain)'
}

# 3) install into the dedicated profile (no backend/workbench)
Step ('setup-profile ' + $Profile)
powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'setup-profile.ps1') `
    -HarnessDir $HarnessDir -CoreDir $CoreDir -RuntimeDir $RuntimeDir -BundleDir $Root -ProfileName $Profile
if ($LASTEXITCODE -ne 0) { Fail 'setup-profile' }

# 4) import the issued package as-is; activation is a human act (never auto-signed)
Step 'seed-release import'
node (Join-Path $PSScriptRoot 'seed-release.mjs')
if ($LASTEXITCODE -ne 0) { Fail 'seed-release import' }
if ($AuthorizedBy.Trim() -eq '') {
    $AuthorizedBy = Read-Host 'Authorizing deployer name (manual activation, required)'
}
if ($AuthorizedBy.Trim() -eq '') { Fail 'activation requires an authorized human' }
Step ('activate by ' + $AuthorizedBy)
node (Join-Path $PSScriptRoot 'seed-release.mjs') activate $AuthorizedBy
if ($LASTEXITCODE -ne 0) { Fail 'activate' }

# 5) composition assertion (this plugin present; backend/workbench absent)
Step 'dump-config assert'
powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dump-config.ps1') -HarnessDir $HarnessDir -ProfileName $Profile
if ($LASTEXITCODE -ne 0) { Fail 'dump-config' }

# 6) controlled restart: only this profile host on -Port; platform / other profiles untouched
if ($Restart) {
    if ($Port -le 0) { Fail '-Restart requires -Port <target host port>' }
    Step ('controlled restart on port ' + $Port)
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
        foreach ($procId in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
            # 只杀「本插件 profile 宿主」：核对进程命令行含 --profile <本 profile>，否则拒绝（不误杀端口上的其它进程）
            $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $procId) -ErrorAction SilentlyContinue
            $cmdline = if ($proc -and $proc.CommandLine) { $proc.CommandLine } else { '' }
            if ($cmdline -notmatch ('--profile\s+' + [regex]::Escape($Profile))) {
                Fail ('port ' + $Port + ' 上进程 ' + $procId + ' 不是本 profile（' + $Profile + '）宿主，拒绝杀进程: ' + $cmdline)
            }
            Stop-Process -Id $procId -Force
        }
        Start-Sleep -Seconds 2
    }
    $outLog = Join-Path $Root ('deploy-' + $Port + '.out.log')
    $errLog = Join-Path $Root ('deploy-' + $Port + '.err.log')
    # 数据（plugin.config.json / 参数）不拼代码：单引号转义 + -LiteralPath；profile 已过字符集校验并同样加引号
    $harnessQ = $HarnessDir.Replace("'", "''")
    $profileQ = $Profile.Replace("'", "''")
    $cmd = "Set-Location -LiteralPath '" + $harnessQ + "'; pnpm dsh --profile '" + $profileQ + "' --no-open --port " + [int]$Port
    Start-Process -FilePath 'powershell' -ArgumentList '-ExecutionPolicy', 'Bypass', '-Command', $cmd `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden
    Write-Host ('host starting: profile=' + $Profile + ' port=' + $Port + ' log=' + $outLog)
}

# 7) dual-entry acceptance anchors: baseline proven current by step 2; -Data (RuntimeDataset) runs live instead.
#    Page and Agent faces must reproduce the same ruleId set and scores.
Step 'acceptance anchors (dual-entry)'
$outJson = Join-Path $Root 'deploy-accept.json'
$expectedPath = Join-Path $PackageDir ('fixtures/replay-' + $ScenarioId + '.expected.json')
if ($Data -ne '') {
    node (Join-Path $CoreDir 'dist/cli.js') run $PackageDir $ScenarioId --data $Data --out $outJson
    if ($LASTEXITCODE -ne 0) { Fail 'acceptance run' }
    $accept = Get-Content $outJson -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host 'anchor source: live run (-Data)'
} elseif ($isDataset -and (Test-Path (Join-Path $Root 'tests/fixtures/replay.json'))) {
    node (Join-Path $CoreDir 'dist/cli.js') run $PackageDir $ScenarioId --data (Join-Path $Root 'tests/fixtures/replay.json') --out $outJson
    if ($LASTEXITCODE -ne 0) { Fail 'acceptance run (packaged dataset fixture)' }
    $accept = Get-Content $outJson -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host 'anchor source: live run (packaged dataset fixture)'
} elseif (Test-Path $expectedPath) {
    $accept = Get-Content $expectedPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host 'anchor source: packaged replay baseline (verified by step 2)'
} else {
    if ($isDataset) {
        Fail 'no anchor source: dataset 模式无回放基线——用 -Data <dataset.json> 指定验收数据集（或包内 tests/fixtures/replay.json 已就位）'
    }
    Fail 'no anchor source (missing replay baseline and no -Data)'
}
Write-Host ''
Write-Host ('humanReviewRequired: ' + $accept.humanReviewRequired)
foreach ($c in $accept.candidates) {
    $rules = ($c.hitRuleIds -join ',')
    Write-Host ('  ' + $c.candidateId + '  riskScore=' + $c.riskScore + '  hitRuleIds=[' + $rules + ']')
}
foreach ($e in $accept.excluded) {
    Write-Host ('  excluded ' + $e.candidateId + ' by ' + $e.ruleId)
}
Write-Host ''
Write-Host 'Dual-entry acceptance (ruleId set and scores must match the anchors above):' -ForegroundColor Yellow
if ($isDataset) {
    Write-Host ('  Page : domain panel -> ' + $ScenarioId + ' -> paste dataset JSON -> run')
    Write-Host ('  Agent: run_scenario(name=' + $PkgName + ', version=' + $PkgVersion + ', scenarioId=' + $ScenarioId + ', dataset=<inline>)')
    Write-Host ('  Data channel: inline dataset (unverified) — same runScenario path for Page and Agent')
} else {
    Write-Host ('  Page : domain panel -> ' + $ScenarioId + ' -> run (sourceId=' + $SourceId + ')')
    Write-Host ('  Agent: run_scenario(name=' + $PkgName + ', version=' + $PkgVersion + ', scenarioId=' + $ScenarioId + ', sourceId=' + $SourceId + ')')
    Write-Host ('  Data source: without ' + $ApiEnvName + ' the sourceId run must deny (fail-closed); identity asserts DSH_BIZ_* same as startup')
}
Write-Host ''
Write-Host 'deploy chain: OK' -ForegroundColor Green
