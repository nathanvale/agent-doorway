# Repository commands

Use the existing repository CLI at src/cli.ts. Add commands through src/commands.ts.
Keep domain implementation in separate files and preserve one public application CLI.

Check command: bun run check
Smoke: bun run start --help
Source packet: https://github.com/nathanvale/agent-doorway
Template source: c0d61de4015ad03732920c267817d8f9ae3a191c

## Comments

Lint refuses a comment in code, so say it in a name, a type or a test title.
A comment that opens with `Platform:` or `Interface:` makes a claim that a reviewer checks. It is not a way to keep a comment.

The lint rule files in config/ are the template's. Change a lint rule in the template, not here.
