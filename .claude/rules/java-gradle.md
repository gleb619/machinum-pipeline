---
globs: ["**/*.java", "**/*.gradle", "settings.gradle", "build.gradle", "core/**", "cli/**", "server/**", "mcp/**"]
---
# Java/Gradle Rules
- Treat `docs/tdd.md` as design intent, not guaranteed implementation.
- Prefer small, focused classes and clear interfaces between modules.
- Add or change commands/tasks only when corresponding Gradle/config files exist.
