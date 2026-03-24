---
globs: ["docs/**/*.md", "README.md", "AGENTS.md", "CLAUDE.md", "WARP.md"]
---
# Docs & Bootstrap Rules
- Treat `docs/tdd.md` as design intent, not guaranteed implementation.
- Keep documentation consistent with actual repo state.
- Avoid claiming build/test commands exist unless verified in repository.
- Keep architecture descriptions consistent with:
  - state-machine execution over items
  - tool execution per state with optional Groovy conditions
  - checkpoint/resume semantics
  - internal + external tool support
- Keep edits minimal and concrete; avoid speculative roadmap churn.
