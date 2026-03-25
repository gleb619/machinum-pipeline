# AGENTS.md
Read `CLAUDE.md` for all project guidance and working rules.
This file intentionally delegates to `CLAUDE.md` as the single source of truth.

## Required Claude Subagents (OpenCode)
For delegated work, use the following subagents and configure each to use `opencode`:
- `.claude/agents/code-reviewer.md`
- `.claude/agents/planner.md`
- `.claude/agents/tester.md`

## Active Technologies
- Java 25 + Gradle 8.x (actually 9.4.1), Picocli 4.7+, SnakeYAML 2.0+, Jackson 2.17+, Groovy 4.0+, SLF4J + Logback 
- Local filesystem for run state, checkpoints, and workspace structure (`.mt/`, `src/main/`, `build/`) 

## Recent Changes
- 001-phase1-mvp-foundation: Added Java 25 + Gradle 8.x, Picocli, SnakeYAML, Jackson, SLF4J + Logback
- 001-phase1-mvp-foundation: Added [if applicable, e.g., Json, CoreData, files or N/A]
- 002-external-tools-support: Added Java 25 + Gradle 8.x (actually 9.4.1), Picocli 4.7+, SnakeYAML 2.0+, Jackson 2.17+, Groovy 4.0+, SLF4J + Logback
