/** Minimal TAX run styles (subset of workbench ow-* tokens). */
export const CSS = `
.txri-gov { font-size: 13px; line-height: 1.45; color: inherit; }
.txri-gov h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.txri-gov .txri-sub { opacity: 0.7; margin: 0 0 12px; font-size: 12px; }
.txri-gov .txri-note { opacity: 0.65; font-size: 12px; margin: 8px 0; }
.txri-gov .txri-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.txri-gov .txri-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.txri-gov button {
  cursor: pointer; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: transparent; color: inherit; border-radius: 6px; padding: 4px 10px; font-size: 12px;
}
.txri-gov button:disabled { opacity: 0.5; cursor: default; }
.txri-gov button.txri-primary {
  border-color: #2f9e44; color: #2f9e44; font-weight: 600;
}
.txri-gov table { width: 100%; border-collapse: collapse; margin: 6px 0 14px; font-size: 12px; }
.txri-gov th, .txri-gov td { text-align: left; padding: 5px 6px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); vertical-align: top; }
.txri-gov th { opacity: 0.7; font-weight: 600; }
.txri-gov .tag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
.txri-gov .tag.ok { border-color: #2f9e44; color: #2f9e44; }
.txri-gov .tag.warn { border-color: #e67700; color: #e67700; }
.txri-gov .tag.err { border-color: #e03131; color: #e03131; }
.txri-gov .txri-err { color: #e03131; margin: 8px 0; }
.txri-gov .txri-ok { color: #2f9e44; margin: 8px 0; font-size: 12px; }
.txri-gov select, .txri-gov input {
  background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 6px; padding: 3px 6px; font-size: 12px; max-width: 100%; font-family: inherit;
}
.txri-gov .txri-panel { border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 8px; padding: 10px; }
.txri-gov ul { margin: 4px 0 10px; padding-left: 18px; }
.txri-gov li { margin: 2px 0; }
.txri-gov .txri-card { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 8px; padding: 8px 10px; margin: 6px 0; }
.txri-gov .txri-card > h4 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.txri-gov .txri-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 4px 0; }
.txri-gov .txri-stat { min-width: 96px; }
.txri-gov .txri-stat .k { display: block; opacity: 0.65; font-size: 11px; }
.txri-gov .txri-stat .v { font-size: 15px; font-weight: 600; }
.txri-gov .txri-thbtn { cursor: pointer; border: none; background: transparent; color: inherit; font: inherit; font-weight: 600; padding: 0; opacity: 0.85; }
.txri-gov .txri-exp { margin: 4px 0 8px; padding: 6px 8px; border-left: 2px solid color-mix(in srgb, currentColor 25%, transparent); }
.txri-gov .txri-kv { width: auto; margin: 4px 0 8px; }
.txri-gov .txri-kv td { border-bottom: none; padding: 2px 10px 2px 0; }
.txri-gov .tag.success { border-color: #2f9e44; color: #2f9e44; }
.txri-gov .tag.danger { border-color: #e03131; color: #e03131; }
.txri-gov .tag.accent { border-color: #4c6ef5; color: #4c6ef5; }
.txri-gov .tag.info { border-color: #4c6ef5; color: #4c6ef5; }
.txri-gov .tag.muted { opacity: 0.7; }
.txri-gov .txri-callout { border-left: 3px solid currentColor; border-radius: 6px; padding: 6px 10px; margin: 6px 0; opacity: 0.95; }
.txri-gov .txri-callout-info { color: #4c6ef5; }
.txri-gov .txri-callout-success { color: #2f9e44; }
.txri-gov .txri-callout-warning { color: #e67700; }
.txri-gov .txri-callout-error { color: #e03131; }
.txri-gov .txri-pbar { width: 120px; height: 6px; border-radius: 999px; background: color-mix(in srgb, currentColor 15%, transparent); overflow: hidden; margin: 4px 0; }
.txri-gov .txri-pfill { height: 100%; border-radius: 999px; background: currentColor; }
.txri-gov .txri-timeline ul { list-style: none; margin: 6px 0; padding-left: 12px; border-left: 2px solid color-mix(in srgb, currentColor 20%, transparent); }
.txri-gov .txri-timeline li { margin: 0 0 10px 8px; }
.txri-gov .txri-tabs .txri-bar { margin-bottom: 6px; }
.txri-gov .txri-chart { margin: 6px 0 10px; }
.txri-gov .txri-chart svg { display: block; max-width: 100%; }
.txri-gov .txri-num { text-align: right; }
.txri-gov .txri-cellbar { display: flex; align-items: center; gap: 6px; min-width: 90px; }
.txri-gov .txri-cellbar .txri-pfill { flex: 0 0 auto; min-width: 2px; }
.txri-gov .txri-spark { display: inline-block; vertical-align: middle; margin-left: 8px; opacity: 0.8; }
.txri-gov .txri-layout { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.4fr); gap: 14px; align-items: start; }
@media (max-width: 900px) { .txri-gov .txri-layout { grid-template-columns: 1fr; } }
.txri-gov .txri-cand-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
.txri-gov .txri-warnbox { border-left: 3px solid #e67700; padding: 6px 10px; margin: 6px 0; font-size: 12px; opacity: 0.95; }
.txri-gov .txri-section { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); margin-top: 10px; padding-top: 8px; }
.txri-gov button.txri-danger { border-color: #e03131; color: #e03131; }
`
