/** Minimal AML governance styles (subset of workbench ow-* tokens). */
export const CSS = `
.amli-gov { font-size: 13px; line-height: 1.45; color: inherit; }
.amli-gov h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.amli-gov h4 { margin: 12px 0 4px; font-size: 13px; font-weight: 600; }
.amli-gov .amli-sub { opacity: 0.7; margin: 0 0 12px; font-size: 12px; }
.amli-gov .amli-note { opacity: 0.65; font-size: 12px; margin: 8px 0; }
.amli-gov .amli-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.amli-gov .amli-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.amli-gov button {
  cursor: pointer; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: transparent; color: inherit; border-radius: 6px; padding: 4px 10px; font-size: 12px;
}
.amli-gov button:disabled { opacity: 0.5; cursor: default; }
.amli-gov button.amli-primary {
  border-color: #1971c2; color: #1971c2; font-weight: 600;
}
.amli-gov button.amli-danger {
  border-color: #e03131; color: #e03131;
}
.amli-gov table { width: 100%; border-collapse: collapse; margin: 6px 0 14px; font-size: 12px; }
.amli-gov th, .amli-gov td { text-align: left; padding: 5px 6px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); vertical-align: top; }
.amli-gov th { opacity: 0.7; font-weight: 600; }
.amli-gov .tag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
.amli-gov .tag.ok { border-color: #2f9e44; color: #2f9e44; }
.amli-gov .tag.warn { border-color: #e67700; color: #e67700; }
.amli-gov .tag.err { border-color: #e03131; color: #e03131; }
.amli-gov .amli-err { color: #e03131; margin: 8px 0; }
.amli-gov .amli-ok { color: #2f9e44; margin: 8px 0; font-size: 12px; }
.amli-gov .amli-sim { opacity: 0.75; font-size: 11px; margin-top: 4px; }
.amli-gov select, .amli-gov input, .amli-gov textarea {
  background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 6px; padding: 3px 6px; font-size: 12px; max-width: 100%; font-family: inherit;
}
.amli-gov textarea { width: 100%; min-height: 48px; box-sizing: border-box; }
.amli-gov .amli-layout { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.4fr); gap: 16px; align-items: start; }
.amli-gov .amli-panel { border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 8px; padding: 10px; }
.amli-gov .amli-warnbox {
  border: 1px solid #e67700; color: #e67700; border-radius: 6px; padding: 6px 8px;
  font-size: 12px; margin: 6px 0;
}
.amli-gov .amli-cand-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 4px 0; }
.amli-gov .amli-evidence li { margin: 2px 0; }
.amli-gov ul { margin: 4px 0; padding-left: 18px; }
.amli-gov .amli-section { margin-top: 10px; padding-top: 8px; border-top: 1px dashed color-mix(in srgb, currentColor 15%, transparent); }
@media (max-width: 900px) {
  .amli-gov .amli-layout { grid-template-columns: 1fr; }
}
`
