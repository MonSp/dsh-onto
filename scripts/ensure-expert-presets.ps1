# Ensure the dsh-onto expert preset block in the profile's cordis.patch.yml (idempotent).
#
# Expert presets = a copy of the shipped preset-standard plugin list with the persona
# prefix swapped for a package-focus instruction (model-visible). Selectable on the
# conversation hero chip; the Host applies the pick to the blank session; the session
# header's AgentPresetLabel shows the active expert.
#
# Data lives in expert-presets.json (display strings) and preset-plugins.standard.yaml
# (shipped plugin list) - this script stays ASCII-only. Regenerate the template from
# `pnpm dsh --dump-config` (the preset-standard `plugins:` block) when the harness
# upgrades change the standard set.
param(
    [string]$ProfileName = 'dsh-onto',
    [string]$DataPath = (Join-Path $PSScriptRoot 'expert-presets.json'),
    [string]$TemplatePath = (Join-Path $PSScriptRoot 'preset-plugins.standard.yaml')
)
$ErrorActionPreference = 'Stop'

$profileRoot = Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles'
$patchFile = Join-Path (Join-Path $profileRoot $ProfileName) 'cordis.patch.yml'
if (-not (Test-Path $patchFile)) { throw "profile patch not found: $patchFile" }
if (-not (Test-Path $DataPath)) { throw "expert preset data not found: $DataPath" }
if (-not (Test-Path $TemplatePath)) { throw "standard plugins template not found: $TemplatePath" }

$utf8 = [System.Text.UTF8Encoding]::new($false)
$text = [System.IO.File]::ReadAllText($patchFile, $utf8)
$data = [System.IO.File]::ReadAllText($DataPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$templateLines = [System.IO.File]::ReadAllLines($TemplatePath, [System.Text.Encoding]::UTF8)

$begin = $data.begin
$end = $data.end

# Drop any previous managed block (idempotent rewrite). The first note line is a
# fallback start marker: an earlier write could lose the BEGIN line and leave an
# orphan block that a BEGIN-only scan would miss.
$bi = $text.IndexOf($begin)
$ni = if ($data.note.Count -gt 0) { $text.IndexOf([string]$data.note[0]) } else { -1 }
$ei = $text.IndexOf($end)
$startPos = -1
if ($bi -ge 0 -and ($ni -lt 0 -or $bi -le $ni)) { $startPos = $bi }
elseif ($ni -ge 0) { $startPos = $ni }
if ($startPos -ge 0 -and $ei -gt $startPos) {
    $text = $text.Substring(0, $startPos).TrimEnd() + "`n"
}
elseif ($ei -ge 0) {
    # Orphan END at EOF with no recognizable start: trim from END to EOF and rebuild.
    $text = $text.Substring(0, $ei).TrimEnd() + "`n"
}
elseif ($startPos -ge 0) {
    throw 'expert preset block has a start marker but no END; fix cordis.patch.yml by hand'
}

$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine('')
[void]$sb.AppendLine($begin)
foreach ($n in $data.note) { [void]$sb.AppendLine($n) }
[void]$sb.AppendLine('- insert:')
foreach ($e in $data.experts) {
    $prefix = $data.prefixTemplate.Replace('{TITLE}', $e.title).Replace('{PKG}', $e.pkg).Replace('{VER}', $e.ver).Replace('{DOM}', $e.dom).Replace('{FOCUS}', $e.focus)
    [void]$sb.AppendLine("  - id: preset-$($e.id)")
    [void]$sb.AppendLine('    name: "@deepseek-ai/dsh-agent-preset"')
    [void]$sb.AppendLine('    config:')
    [void]$sb.AppendLine("      id: $($e.id)")
    [void]$sb.AppendLine("      order: $($e.order)")
    [void]$sb.AppendLine("      name: `"$($e.name)`"")
    [void]$sb.AppendLine("      description: `"$($e.description)`"")
    # Template is dumped at top-level-entry depth; inside `insert:` it sits two deeper.
    foreach ($row in $templateLines) {
        $shifted = if ($row -eq '') { $row } else { '  ' + $row }
        if ($shifted -like '*prefix: You are a coding agent powered by the {{model}} model.*') {
            $indent = ($shifted -replace 'prefix:.*$', '')
            [void]$sb.AppendLine($indent + 'prefix: "' + $prefix + '"')
        }
        else {
            [void]$sb.AppendLine($shifted)
        }
    }
}

# Expert delegation tool: lets the model call a child agent under a chosen expert
# preset (dsh-tool-subagent allowedAgentPresets -> agent_preset argument). Top-level
# so standard sessions can dispatch to experts without a preset switch (the Host
# locks a started session's own composition).
if ($data.expertTool) {
    $et = $data.expertTool
    [void]$sb.AppendLine('- insert:')
    [void]$sb.AppendLine("  - id: $($et.id)")
    [void]$sb.AppendLine('    name: "@deepseek-ai/dsh-tool-subagent"')
    [void]$sb.AppendLine('    config:')
    [void]$sb.AppendLine('      provider: spawn')
    [void]$sb.AppendLine("      toolName: $($et.toolName)")
    [void]$sb.AppendLine("      agentPreset: $($et.defaultPreset)")
    [void]$sb.AppendLine('      allowedAgentPresets:')
    foreach ($presetId in $et.presets) { [void]$sb.AppendLine("        - $presetId") }
}
[void]$sb.AppendLine($end)

[System.IO.File]::WriteAllText($patchFile, $text.TrimEnd() + "`n" + $sb.ToString().TrimStart("`n"), $utf8)
Write-Host "expert presets ensured: $($data.experts.Count) entries -> $patchFile"
