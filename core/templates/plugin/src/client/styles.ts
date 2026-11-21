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
`
