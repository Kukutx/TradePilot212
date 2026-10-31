// A host's style variables, as an MCP Apps host hands them over (hostContext.styles.variables), so the preview, and
// the UI audit with it, can show the widget in a host that gives its own colours, type, corners and shadows as well as
// in one that gives none. The values are a warm chat host's of our own making, each light-dark(), as the spec asks;
// far enough from the widget's own fallbacks that a variable read in the wrong place shows.

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps";

// The spec's type lists every variable; a host may give any part of them, as this one does.
export const HOST_STYLES = {
  "--color-background-primary": "light-dark(#fffdf9, #262624)",
  "--color-background-secondary": "light-dark(#f4f2ec, #30302d)",
  "--color-background-tertiary": "light-dark(#eae7df, #3a3a36)",
  "--color-background-info": "light-dark(#ebf2fe, #17263f)",
  "--color-background-danger": "light-dark(#fdeceb, #3b1a17)",
  "--color-background-success": "light-dark(#eaf6ee, #16301f)",
  "--color-background-warning": "light-dark(#fcf2da, #36290f)",
  "--color-text-primary": "light-dark(#1f1e1c, #f2f1ed)",
  "--color-text-secondary": "light-dark(#5c5b57, #b5b3ac)",
  "--color-text-tertiary": "light-dark(#7d7c77, #908e88)",
  "--color-text-info": "light-dark(#1d58b8, #8ab1ff)",
  "--color-text-danger": "light-dark(#b0261c, #f8776d)",
  "--color-text-success": "light-dark(#1c743a, #5fc98a)",
  "--color-text-warning": "light-dark(#835500, #f2b850)",
  "--color-border-primary": "light-dark(#e4e0d7, #3e3d39)",
  "--color-border-secondary": "light-dark(#cdc8bd, #55534e)",
  "--color-ring-primary": "light-dark(#2b66d9, #8ab1ff)",
  "--font-sans": "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  "--font-mono": "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace",
  "--border-radius-sm": "6px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "12px",
  "--border-radius-xl": "16px",
  "--border-radius-full": "9999px",
  "--shadow-hairline": "0 0 0 1px rgba(31, 30, 28, .04), 0 1px 2px rgba(31, 30, 28, .05)",
} as Partial<McpUiStyles> as McpUiStyles;
