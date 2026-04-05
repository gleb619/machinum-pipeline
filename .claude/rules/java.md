---
globs: ["**/*.java"]
---
# Java Code Formatting Rules

## Tooling
- Project uses **Spotless** with **Palantir Java Format** for code formatting
- Always run `./gradlew spotlessApply` before committing
- CI enforces formatting via `./gradlew spotlessCheck`

## Style
- Follow **Google Java Style** (2-space indentation, not 4)
- Do not manually reformat code — let Spotless handle it
- Never disable or bypass Spotless checks

## Javadoc
- Javadoc is not required, allowed only public classes. Methods and fields **SHOULDN'T have Javadoc**
- Javadoc is auto-formatted — write content, not alignment
- Keep Javadoc concise and meaningful

### Good Javadoc
/**
* Calculates the total price including tax.
*
*/

### Bad Javadoc
/**
* Gets the name.
*/

## General Code Rules
- Write clean, readable code — formatting is automated, logic is not
- Avoid large methods; keep them focused and short
- Use meaningful variable and method names
- Prefer `var` types over explicit ones where clarity not matters

## Workflow
1. Write your code
2. Run `./gradlew spotlessApply` before tests
3. Run specific tests via `./gradlew test --tests "machinum.pipeline.MyTestClass"` to check the changed code 

## Java Rules

- Treat `docs/tdd.md` as design intent, not guaranteed implementation.
- All Java development MUST go through TDD (Test-Driven Development): red → green → refactor.
- For behavior changes, write or update failing tests first, then implement minimal passing code, then refactor with tests green.
- Run relevant module tests during development and full affected suite before handoff.
- Prefer small, focused records and clear interfaces between modules.
- Add or change commands/tasks only when corresponding Gradle/config files exist.
