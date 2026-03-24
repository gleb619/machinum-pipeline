---
globs: ["**/*.java", "**/*.gradle", "settings.gradle", "build.gradle", "core/**", "cli/**", "server/**", "mcp/**"]
---
# Java/Gradle Rules
- Keep module boundaries explicit: `core`, `cli`, `server`, `mcp`.
- Prefer small, focused classes and clear interfaces between modules.
- For orchestration logic, preserve:
  - deterministic state transitions
  - explicit condition evaluation boundaries
  - checkpoint persistence points
  - configurable error strategies (`stop` / `skip` / `retry`)
- For external tools (shell/docker), enforce clear JSON input/output boundaries.
- Do not mix CLI/server concerns into core execution engine.
- Add or change commands/tasks only when corresponding Gradle/config files exist.
