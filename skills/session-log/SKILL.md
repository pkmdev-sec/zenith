---
name: session-log
description: Write a durable session log capturing completed work, findings, open questions, and next steps. Use when the user asks to log progress, save session notes, write up what was done, or create a research diary entry.
---

# Session Log

Write a session log capturing what happened this session. There is no dedicated prompt for
this; do the following inline:

1. Derive a slug from the session topic (lowercase, hyphens, ≤5 words).
2. Write `notes/session-logs/<YYYY-MM-DD>-<slug>.md` with:
   - **What was done** — bullet list of concrete actions.
   - **Strongest findings** — what we now know that we didn't.
   - **Artifacts written** — paths to files produced this session.
   - **Unresolved questions** — what remains unclear.
   - **Next steps** — concrete follow-up actions.
3. If the work spanned multiple rounds of research, also append a concise entry to
   `CHANGELOG.md` summarizing progress, verification status, and next recommended step.

Keep it concise. One screen of text is usually enough.
