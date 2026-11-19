/** Minimal AML governance styles (subset of workbench ow-* tokens). */
export const CSS = `
.aml-gov { font-size: 13px; line-height: 1.45; color: inherit; }
.aml-gov h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.aml-gov .aml-sub { opacity: 0.7; margin: 0 0 12px; font-size: 12px; }
.aml-gov .aml-note { opacity: 0.65; font-size: 12px; margin: 8px 0; }
.aml-gov .aml-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.aml-gov .aml-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.aml-gov button {
  cursor: pointer; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: transparent; color: inherit; border-radius: 6px; padding: 4px 10px; font-size: 12px;
}
.aml-gov button:disabled { opacity: 0.5; cursor: default; }
.aml-gov table { width: 100%; border-collapse: collapse; margin: 6px 0 14px; font-size: 12px; }
.aml-gov th, .aml-gov td { text-align: left; padding: 5px 6px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); vertical-align: top; }
.aml-gov th { opacity: 0.7; font-weight: 600; }
.aml-gov .tag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
.aml-gov .tag.ok { border-color: #2f9e44; color: #2f9e44; }
.aml-gov .tag.warn { border-color: #e67700; color: #e67700; }
.aml-gov .tag.err { border-color: #e03131; color: #e03131; }
.aml-gov .aml-err { color: #e03131; margin: 8px 0; }
.aml-gov .aml-sim { opacity: 0.75; font-size: 11px; margin-top: 4px; }
.aml-gov select, .aml-gov input {
  background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 6px; padding: 3px 6px; font-size: 12px; max-width: 100%;
}
`
