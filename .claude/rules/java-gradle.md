---
globs: ["**/*.java", "**/*.gradle", "settings.gradle", "build.gradle", "core/**", "cli/**", "server/**", "mcp/**"]
---
# Java/Gradle Rules
- Treat `docs/tdd.md` as design intent, not guaranteed implementation.
- All Java development MUST go through TDD (Test-Driven Development): red → green → refactor.
- For behavior changes, write or update failing tests first, then implement minimal passing code, then refactor with tests green.
- Run relevant module tests during development and full affected suite before handoff.
- Prefer small, focused classes and clear interfaces between modules.
- Add or change commands/tasks only when corresponding Gradle/config files exist.
