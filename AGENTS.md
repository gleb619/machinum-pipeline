# AGENTS.md
Guidance for agentic work in this repository.

## Primary references
- Claude project context: [`CLAUDE.md`](./CLAUDE.md)
- Lowercase entrypoint: [`claude.md`](./claude.md)
- Detailed architecture intent: [`docs/tdd.md`](./docs/tdd.md)
- Task/context article: [`docs/task.md`](./docs/task.md)

## Agent profiles
- Planner: [`.claude/agents/planner.md`](./.claude/agents/planner.md)
- Tester: [`.claude/agents/tester.md`](./.claude/agents/tester.md)
- Code reviewer: [`.claude/agents/code-reviewer.md`](./.claude/agents/code-reviewer.md)

## Rule profiles
- Docs/bootstrap behavior: [`.claude/rules/docs-bootstrap.md`](./.claude/rules/docs-bootstrap.md)
- Java/Gradle behavior: [`.claude/rules/java-gradle.md`](./.claude/rules/java-gradle.md)

## Project phase
- The project is moving from documentation/bootstrap into active development.
- Keep implementation steps incremental and minimal.
- Verify repository reality before assuming build/test/scaffold availability.

## Architecture constraints to preserve
- Pipeline orchestration is a state machine over items.
- Each state may run one or more tools with optional Groovy-based conditions.
- Checkpoint persistence and resume are core requirements.
- Internal Java tools and external shell/docker tools must both remain supported.
- Intended module boundaries: `core`, `cli`, `server`, `mcp`.

## Development workflow
1. Read relevant docs and existing implementation first.
2. For non-trivial tasks, plan before coding.
3. Implement in small reviewable diffs.
4. Validate only with commands actually supported by current repo files.
5. Avoid destructive changes (deletions/rewrites) unless explicitly requested.

## Command and validation policy
- Do not assume `./gradlew` commands exist until wrapper/build files are present.
- If test/lint framework is not present, report that clearly and propose the minimum next step.
- Keep assumptions explicit: distinguish implemented behavior from planned behavior.
