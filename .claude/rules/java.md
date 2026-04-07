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
- Javadoc is not required; allowed only on public classes. Methods and fields **MUST NOT have Javadoc**
- Javadoc is auto-formatted — write content, not alignment
- Keep Javadoc concise and meaningful

## General Code Rules
- Write clean, readable code — formatting is automated, logic is not
- Avoid large methods; keep them focused and short
- Use meaningful variable and method names
- Prefer `var` over explicit types where clarity is not affected

## Functional Programming
- Prefer functional interfaces over imperative patterns:
  - Use `Function<Input, Output>` for transformations
  - Use `Supplier<T>` for deferred/lazy values
  - Use `Consumer<T>` for side-effectful operations
  - Use `Predicate<T>` for conditions and filters
  - Use `BiFunction`, `UnaryOperator`, `BinaryOperator` where appropriate
- Avoid mutation; prefer returning new values(via lombok's `toBuilder`) over modifying state
- Compose functions using `.andThen()`, `.compose()`, `.map()`, `.flatMap()` where possible
- Avoid passing many arguments to methods — wrap related parameters in a param object (record)

## Records & Lombok
- Prefer **records** for immutable data carriers and parameter objects
- Use **Lombok `@Builder`** on records for ergonomic construction:
  ```java
  @Builder
  public record MyContext(String name, int count, boolean enabled) {}
  ```
- Group related records **in the same file** by business logic domain (e.g., input/output/config records for the same feature live together)
- Avoid plain POJOs or classes where a record suffices
- For param objects replacing long argument lists, always use a record with a builder:
  ```java
  // Avoid:
  void process(String input, int limit, boolean strict, Locale locale) { ... }

  // Prefer:
  @Builder
  public record ProcessContext(String input, int limit, boolean strict, Locale locale) {}

  void process(ProcessContext context) { ... }
  ```

## Workflow
1. Write your code
2. Run `./gradlew spotlessApply` before tests
3. Run specific tests via `./gradlew test --tests "machinum.pipeline.MyTestClass"` to verify changes

## Java Rules
- Treat `docs/tdd.md` as design intent, not guaranteed implementation
- All Java development MUST follow TDD: red → green → refactor
- For behavior changes, write or update failing tests first, then implement minimal passing code, then refactor with tests green
- Run relevant module tests during development and the full affected suite before handoff
- Prefer small, focused records and clear interfaces between modules
- Add or change commands/tasks only when corresponding Gradle/config files exist