---
name: gradle-build
description: Work with Gradle multi-module build configuration for Machinum Pipeline. Use when modifying build files, adding dependencies, or managing module structure.
---

# Gradle Build Skill

## Instructions

Work with the Gradle multi-module project structure following the patterns established in the Machinum Pipeline project.

### Project Structure

```
machinum-pipeline/
├── build.gradle              # Root build configuration
├── settings.gradle           # Module definitions
├── gradle/
│   ├── wrapper/
│   │   └── gradle-wrapper.properties
│   └── libs.versions.toml    # Version catalog
├── core/                     # Core module
│   └── build.gradle
├── cli/                      # CLI module
│   └── build.gradle
└── server/                   # Server module
    └── build.gradle
```

### Root Build Configuration (`build.gradle`)

```gradle
plugins {
    id 'java-library'
    id 'groovy'
    alias(libs.plugins.spring.boot) apply false
    alias(libs.plugins.jooby) apply false
}

allprojects {
    group = 'machinum'
    version = '1.0.0-SNAPSHOT'
    
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
    
    java {
        toolchain {
            languageVersion = JavaLanguageVersion.of(25)
        }
    }
}

subprojects {
    apply plugin: 'java-library'
    apply plugin: 'groovy'
    
    dependencies {
        implementation(libs.bundles.slf4j)
        testImplementation(libs.bundles.junit)
        testImplementation(libs.groovy)
    }
    
    test {
        useJUnitPlatform()
    }
}
```

### Settings Configuration (`settings.gradle`)

```gradle
rootProject.name = 'machinum-pipeline'

include 'core'
include 'cli'
include 'server'
```

### Version Catalog (`gradle/libs.versions.toml`)

```toml
[versions]
java = "25"
gradle = "8.9"
groovy = "4.0"
junit = "5.10"
slf4j = "2.0"
logback = "1.4"
jackson = "2.17"
picocli = "4.7"
snakeyaml = "2.0"
jooby = "4.1"

[libraries]
# Core dependencies
groovy-core = { module = "org.apache.groovy:groovy", version.ref = "groovy" }
jackson-core = { module = "com.fasterxml.jackson.core:jackson-core", version.ref = "jackson" }
jackson-databind = { module = "com.fasterxml.jackson.core:jackson-databind", version.ref = "jackson" }
jackson-yaml = { module = "com.fasterxml.jackson.dataformat:jackson-dataformat-yaml", version.ref = "jackson" }
snakeyaml = { module = "org.yaml:snakeyaml", version.ref = "snakeyaml" }

# Logging
slf4j-api = { module = "org.slf4j:slf4j-api", version.ref = "slf4j" }
logback-classic = { module = "ch.qos.logback:logback-classic", version.ref = "logback" }

# CLI
picocli-core = { module = "info.picocli:picocli", version.ref = "picocli" }
picocli-codegen = { module = "info.picocli:picocli-codegen", version.ref = "picocli" }

# Server
jooby-core = { module = "io.jooby:jooby", version.ref = "jooby" }
jooby-netty = { module = "io.jooby:jooby-netty", version.ref = "jooby" }

# Testing
junit-jupiter = { module = "org.junit.jupiter:junit-jupiter", version.ref = "junit" }
junit-platform = { module = "org.junit.platform:junit-platform-launcher" }
groovy-test = { module = "org.apache.groovy:groovy-test", version.ref = "groovy" }

[bundles]
slf4j = ["slf4j-api", "logback-classic"]
jackson = ["jackson-core", "jackson-databind", "jackson-yaml"]
junit = ["junit-jupiter", "junit-platform"]
picocli = ["picocli-core", "picocli-codegen"]

[plugins]
spring-boot = { id = "org.springframework.boot", version = "3.2.0" }
jooby = { id = "io.jooby.jooby-gradle-plugin", version.ref = "jooby" }
```

### Module Build Patterns

#### Core Module (`core/build.gradle`)

```gradle
plugins {
    id 'java-library'
}

dependencies {
    api(libs.bundles.jackson)
    api(libs.snakeyaml)
    implementation(libs.bundles.slf4j)
    
    testImplementation(libs.bundles.junit)
    testImplementation(libs.groovy.test)
}

jar {
    archiveBaseName = 'machinum-core'
}

java {
    withSourcesJar()
}
```

#### CLI Module (`cli/build.gradle`)

```gradle
plugins {
    id 'java-library'
    alias(libs.plugins.picocli)
}

dependencies {
    implementation(project(':core'))
    implementation(libs.picocli.core)
    implementation(libs.bundles.slf4j)
    
    testImplementation(project(':core'))
    testImplementation(libs.bundles.junit)
}

application {
    mainClass = 'machinum.cli.MachinumCli'
}

jar {
    manifest {
        attributes 'Main-Class': 'machinum.cli.MachinumCli'
    }
}

tasks.named('compileJava') {
    options.compilerArgs += ['-Aproject=${project.group}/${project.name}']
}
```

#### Server Module (`server/build.gradle`)

```gradle
plugins {
    id 'java-library'
    alias(libs.plugins.jooby)
}

dependencies {
    implementation(project(':core'))
    implementation(libs.jooby.core)
    implementation(libs.jooby.netty)
    implementation(libs.bundles.slf4j)
    
    testImplementation(project(':core'))
    testImplementation(libs.bundles.junit)
}

jar {
    archiveBaseName = 'machinum-server'
}
```

### Dependency Management

#### Adding New Dependencies

1. **Add to version catalog** (`gradle/libs.versions.toml`):
   ```toml
   [versions]
   new-lib = "1.2.3"
   
   [libraries]
   new-lib-core = { module = "com.example:new-lib", version.ref = "new-lib" }
   
   [bundles]
   new-lib-bundle = ["new-lib-core"]
   ```

2. **Use in module build**:
   ```gradle
   dependencies {
       implementation(libs.new.lib.core)
       // or
       implementation(libs.bundles.new.lib.bundle)
   }
   ```

#### Module Dependencies

- **api**: Exposed to consumers
- **implementation**: Internal to module
- **testImplementation**: Test-only dependencies

### Common Tasks

```bash
# Build all modules
./gradlew build

# Run tests
./gradlew test

# Run specific module tests
./gradlew :cli:test

# Build with dependencies
./gradlew :cli:build --info

# Generate dependency tree
./gradlew dependencies

# Update dependencies
./gradlew dependencyUpdates
```

### Java Toolchain Configuration

All modules use Java 25 toolchain:

```gradle
java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}
```

### Testing Configuration

All modules use JUnit 5:

```gradle
test {
    useJUnitPlatform()
    
    testLogging {
        events "passed", "skipped", "failed"
    }
}
```

## Templates

Use templates in `templates/` directory for consistent build configuration.

## References

- Gradle documentation for multi-module projects
- Version catalog best practices
- Existing build files in project for patterns
