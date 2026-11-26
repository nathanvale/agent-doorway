---
"agent-doorway": patch
---

Read doorway settings through `readRootedFile` from `agent-cli-kernel/rooted-file` with a 1 MiB limit, refusing symbolic links, linked folders, hard links, root escapes, non-regular files, and over-limit files with `DOMAIN_DOORWAY_SETTINGS_INVALID`.
