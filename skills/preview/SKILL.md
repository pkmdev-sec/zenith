---
name: preview
description: Preview Markdown, LaTeX, PDF, or code artifacts in the browser or as PDF. Use when the user wants to review a written artifact, export a report, or view a rendered document.
---

# Preview

Use the `/preview` command to render and open artifacts (provided by `npm:pi-markdown-preview`).

## Fallback

If the preview command isn't available or the user wants a specific format, use bash:

```bash
open <file.md>          # macOS — opens in default app
open <file.pdf>         # macOS — opens in Preview
xdg-open <file.md>      # Linux
start <file.md>         # Windows
```

For PDF export of markdown, use `pandoc` directly:

```bash
pandoc input.md -o output.pdf --pdf-engine=xelatex
```
