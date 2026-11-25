---
"agent-doorway": patch
---

Hardened remote Docker inventory reading in `src/remote.ts` (`readInventoryResult`) so `doorway open`, `doorway start`, and `doorway list` reject truncated SSH output instead of parsing a partial prefix as complete, and fixed `doorway list --all` so a pinned container stays visible as an inspect-only row when a configured destination resolves by name to a different container.
