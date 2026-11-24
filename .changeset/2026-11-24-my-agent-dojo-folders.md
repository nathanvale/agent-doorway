---
"agent-doorway": major
---

Moved the default settings file to <config base>/my-agent-dojo/doorway/settings.json and the default state folder to <state base>/my-agent-dojo/doorway; doorway open and doorway pending now refuse, with the move command, when only the old place exists.

Action: If a settings file or state folder is left at the old place, run the mkdir -p and mv command that doorway open or doorway pending prints. DOORWAY_SETTINGS and DOORWAY_STATE still override both places.
