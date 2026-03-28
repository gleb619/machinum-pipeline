# Gradle Build Reference

## Project Structure Reference

Based on current project layout:

- Root: `/home/boris/WORKSPACE/machinum-pipeline/`
- Modules: `core/`, `cli/`, `server/`
- Gradle files: `gradle/libs.versions.toml`, `settings.gradle`

## Current Dependencies

From `gradle/libs.versions.toml`:

- Java 25
- Gradle 8.x (Groovy DSL)
- Picocli 4.7+ (CLI)
- SnakeYAML 2.0+ (YAML)
- Jackson 3.1+ (JSON)
- Groovy 4.0+ (Scripting)
- SLF4J + Logback 2.x (Logging)

## Module Patterns

### Core Module

- Provides core pipeline functionality
- Exposes APIs to other modules
- Contains YAML processing, state management

### CLI Module

- Depends on core module
- Provides command-line interface
- Uses Picocli for command parsing

### Server Module

- Depends on core module
- Provides HTTP server interface
- Uses Jooby framework

## Common Build Tasks

```bash
# Clean and build
./gradlew clean build

# Run all tests
./gradlew test

# Build specific module
./gradlew :cli:build

# Run CLI application
./gradlew :cli:run

# Generate test reports
./gradlew test --continue
```

## Dependency Management Best Practices

1. Use version catalog for all dependencies
2. Group related dependencies in bundles
3. Use `api` for exposed dependencies
4. Use `implementation` for internal dependencies
5. Keep test dependencies in `testImplementation`

## Java Toolchain

All modules configured for Java 25:

```gradle
java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}
```
