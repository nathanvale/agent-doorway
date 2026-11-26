---
"agent-doorway": patch
---

Removed the legacy pre-`my-agent-dojo` settings and state path notice (`oldPlaceMessage`, `oldSettingsMessage`, `oldStateMessage`) and its station wording across `list`, `open`, `start`, and `pending`. Missing settings now report only the `my-agent-dojo` settings path, and a folder at `<state base>/doorway` is ignored.
