---
name: gradle-multimodule
description: Work with the Machinum multimodule Gradle 9.4.1 + Java 25 project. Build, test, run CLI commands, and manage dependencies across core, cli, server, and tools modules.
---

# Machinum Gradle Multimodule Project

## Project Overview

Machinum pipeline processing engine with Gradle 9.4.1 + Java 25:
- **`core`** — shared pipeline engine and manifest processing
- **`cli`** — command-line interface with setup/run commands  
- **`server:admin-backend`** — admin API service
- **`server:http-streamer`** — HTTP streaming service
- **`tools:common`** — shared tool utilities
- **`tools:internal`** — built-in processing tools
- **`tools:external`** — external tool wrappers

---

## Quick Start with Examples

```bash
# Setup sample test workspace
./gradlew :cli:run --args="setup -w ./examples/sample-test"

# Run sample pipeline
./gradlew :cli:run --args="run -p sample-pipeline -w ./examples/sample-test"

# Test empty folder setup (auto-defaults)
./gradlew :cli:run --args="setup -w ./examples/fully-empty-folder"

# Setup and run expression test
./gradlew :cli:run --args="setup -w ./examples/expression-test"
./gradlew :cli:run --args="run -p expression-test-pipeline -w ./examples/expression-test"
```

---

## Essential Commands

### Building & Running

```bash
# Build entire project
./gradlew build

# Build specific module
./gradlew :core:build
./gradlew :cli:build

# Build without tests
./gradlew build -x test

# Run CLI with arguments
./gradlew :cli:run --args="setup -w ./my-workspace"
./gradlew :cli:run --args="run -p my-pipeline -w ./my-workspace"

# Clean and rebuild
./gradlew clean build
```

### Testing

```bash
# Run all tests
./gradlew test

# Test specific module
./gradlew :core:test
./gradlew :cli:test

# Run specific test class
./gradlew :core:test --tests "machinum.pipeline.TestClass"
```

---

## Machinum Configuration

### Built-in Mode Flags

Enable built-in tool loading for development:

| Method              | Configuration                                         |
|---------------------|-------------------------------------------------------|
| **Gradle property** | `-PbuiltinToolsEnabled=true`                          |
| **Environment var** | `MT_BUILTIN_TOOLS_ENABLED=true`                       |
| **System property** | `-Dmachinum.builtin.tools=true`                       |
| **Auto-detect**     | `build.gradle` in project root → builtin mode enabled |

### Version Catalog (gradle/libs.versions.toml)

Key versions for Machinum:
```toml
[versions]
java = "25"
jooby = "4.1.0"           # Web framework
picocli = "4.7.6"         # CLI framework
snakeyaml = "2.2"         # YAML processing
groovy = "4.0.21"         # Scripting
jackson = "3.1.0"         # JSON processing
logback = "1.5.3"         # Logging
```

Usage in `build.gradle`:
```groovy
dependencies {
    implementation libs.jooby.core
    implementation libs.picocli
    implementation libs.snakeyaml
    testImplementation libs.junit.jupiter
}
```

---

## Module Dependencies

Machinum-specific dependency patterns:

```groovy
// CLI module depends on core and tools
dependencies {
  implementation project(':core')
  implementation project(':tools:common')
  implementation project(':tools:internal')
  implementation project(':tools:external')

  if (someCondition) {
    // Runtime-only for built-in mode
    runtimeOnly project(':tools:internal')
    runtimeOnly project(':tools:external')
  }
}

// Tools modules depend on common
dependencies {
    implementation project(':tools:common')
}
```

---

## Version & Environment

### Java Setup

```bash
# Use Java 25 in current session
sdk use java 25.0.2-tem

# Verify
java --version
./gradlew --version
```

### Gradle Wrapper

```bash
# Verify wrapper version (should be 9.4.1+)
./gradlew --version

# Parallel builds for faster development
./gradlew build --parallel

# Configuration cache (default in Gradle 9+)
./gradlew build --configuration-cache
```

---

## Quick Reference

| Goal                | Command                                            |
|---------------------|----------------------------------------------------|
| Build all           | `./gradlew build`                                  |
| Build module        | `./gradlew :cli:build`                             |
| Skip tests          | `./gradlew build -x test`                          |
| Run CLI setup       | `./gradlew :cli:run --args="setup -w ."`           |
| Run CLI pipeline    | `./gradlew :cli:run --args="run -p pipeline -w ."` |
| Check dependencies  | `./gradlew :cli:dependencies`                      |
| Clean all           | `./gradlew clean`                                  |
| List tasks          | `./gradlew tasks --all`                            |
| Parallel build      | `./gradlew build --parallel`                       |
| Stacktrace on error | `./gradlew build --stacktrace`                     |

---

## Examples & Testing

```bash
# Run all example setups
./gradlew :cli:run --args="setup -w ./examples/sample-test"
./gradlew :cli:run --args="setup -w ./examples/expression-test"
./gradlew :cli:run --args="setup -w ./examples/empty-body-test"

# Test pipeline execution
./gradlew :cli:run --args="run -p sample-pipeline -w ./examples/sample-test"

# Verify results
ls examples/sample-test/build/
ls examples/sample-test/.mt/state/
```

---

## Troubleshooting

```bash
# Clear Gradle daemon cache
./gradlew --stop
./gradlew build --rerun-tasks

# Force dependency refresh
./gradlew build --refresh-dependencies

# Check daemon status
./gradlew --status

# Built-in mode issues
./gradlew :cli:run --args="setup -w ." -PbuiltinToolsEnabled=true
```

See [docs/cli-commands.md](../../docs/cli-commands.md) for complete CLI reference and [docs/project-structure.md](../../docs/project-structure.md) for built-in mode details.