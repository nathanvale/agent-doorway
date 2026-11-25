---
"agent-doorway": minor
---

Added `doorway start DESTINATION [PLACE]` to start an existing, opted-in (`allowStart: true`) destination container from `exited` or `created` state by its full pinned container ID over SSH, confirm it running, and open it in the isolated editor. Starting is journaled through the state add-on alongside `editor.open`, refuses non-opted-in or unsupported container states without mutating, leaves an unconfirmed start visible in `doorway pending` without opening the editor, and preserves a completed start when the editor fails without stopping the container.
