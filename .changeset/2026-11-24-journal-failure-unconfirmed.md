---
"agent-doorway": minor
---

Changed doorway open so that a state journal record it cannot write or flush ends failed and unknown with DOMAIN_DOORWAY_OPEN_UNCONFIRMED, not refused and unchanged with DOMAIN_DOORWAY_STATE_UNAVAILABLE; the message says whether the isolated editor did not start, stopped unconfirmed, or stopped with its exit code, and a refusal with an unknown result now gets this station instead of an internal result.

Action: When doorway open reports DOMAIN_DOORWAY_OPEN_UNCONFIRMED, run doorway pending to check whether the open is still unfinished, then run doorway open again once the state folder accepts writes.
