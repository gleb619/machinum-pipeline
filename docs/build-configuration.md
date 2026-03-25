# Gradle Multi-Module Build Configuration

## Project Structure

```
machinum/
├── gradle/
│   └── libs.versions.toml
├── settings.gradle
├── build.gradle              # root
├── backend/
│   └── build.gradle
└── frontend/
    └── build.gradle          # wraps yarn
```

---

## `gradle/libs.versions.toml`

```toml
[versions]
java                = "25"
jooby               = "4.1.0"
picocli             = "4.7.6"
snakeyaml           = "2.2"
groovy              = "4.0.21"
jackson             = "2.17.0"
docker-java         = "3.4.0"
logback             = "1.5.3"
slf4j               = "2.0.12"
commons-lang3       = "3.14.0"
commons-io          = "2.15.1"
junit-jupiter       = "5.10.2"
assertj             = "3.25.3"
mockito             = "5.11.0"

# plugins
shadow              = "8.1.1"
test-logger         = "4.0.0"
spotless            = "6.25.0"
openrewrite         = "6.13.0"
versions            = "0.51.0"
dependency-analysis = "1.32.0"
errorprone          = "3.1.0"
nullaway            = "0.10.25"

[libraries]
jooby-core          = { module = "io.jooby:jooby",                                    version.ref = "jooby" }
jooby-netty         = { module = "io.jooby:jooby-netty",                              version.ref = "jooby" }
jooby-jackson       = { module = "io.jooby:jooby-jackson",                            version.ref = "jooby" }
picocli             = { module = "info.picocli:picocli",                               version.ref = "picocli" }
snakeyaml           = { module = "org.yaml:snakeyaml",                                version.ref = "snakeyaml" }
groovy-core         = { module = "org.apache.groovy:groovy",                          version.ref = "groovy" }
groovy-jsr223       = { module = "org.apache.groovy:groovy-jsr223",                   version.ref = "groovy" }
jackson-databind    = { module = "com.fasterxml.jackson.core:jackson-databind",       version.ref = "jackson" }
jackson-yaml        = { module = "com.fasterxml.jackson.dataformat:jackson-dataformat-yaml", version.ref = "jackson" }
docker-core         = { module = "com.github.docker-java:docker-java-core",           version.ref = "docker-java" }
docker-transport    = { module = "com.github.docker-java:docker-java-transport-httpclient5", version.ref = "docker-java" }
logback-classic     = { module = "ch.qos.logback:logback-classic",                    version.ref = "logback" }
slf4j-api           = { module = "org.slf4j:slf4j-api",                               version.ref = "slf4j" }
commons-lang3       = { module = "org.apache.commons:commons-lang3",                  version.ref = "commons-lang3" }
commons-io          = { module = "commons-io:commons-io",                             version.ref = "commons-io" }
junit-jupiter       = { module = "org.junit.jupiter:junit-jupiter",                   version.ref = "junit-jupiter" }
assertj             = { module = "org.assertj:assertj-core",                          version.ref = "assertj" }
mockito             = { module = "org.mockito:mockito-core",                          version.ref = "mockito" }

[plugins]
shadow              = { id = "com.github.johnrengelman.shadow",    version.ref = "shadow" }
test-logger         = { id = "com.adarshr.test-logger",           version.ref = "test-logger" }
spotless            = { id = "com.diffplug.spotless",             version.ref = "spotless" }
openrewrite         = { id = "org.openrewrite.rewrite-gradle-plugin", version.ref = "openrewrite" }
versions            = { id = "com.github.ben-manes.versions",     version.ref = "versions" }
dependency-analysis = { id = "com.autonomousapps.dependency-analysis", version.ref = "dependency-analysis" }
errorprone          = { id = "net.ltgt.errorprone",               version.ref = "errorprone" }
```

---

## `settings.gradle`

```groovy
rootProject.name = "machinum"

include(
    "backend",
    "frontend"
)

// Enable version catalog
dependencyResolutionManagement {
    versionCatalogs {
        create("libs") {
            from(files("gradle/libs.versions.toml"))
        }
    }
}

// Faster configuration caching
enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")
```

---

## `build.gradle` (root)

```groovy
plugins {
    alias(libs.plugins.spotless)         apply false
    alias(libs.plugins.openrewrite)      apply false
    alias(libs.plugins.versions)
    alias(libs.plugins.dependency.analysis)
    alias(libs.plugins.test.logger)      apply false
}

// ./gradlew dependencyUpdates
tasks.withType(com.github.benmanes.gradle.versions.updates.DependencyUpdatesTask) {
    rejectVersionIf {
        def v = candidate.version
        ['alpha', 'beta', 'rc', 'cr', 'm', 'preview', 'b', 'ea'].any {
            v.contains(it, ignoreCase: true)
        }
    }
}

// ./gradlew buildHealth
dependencyAnalysis {
    issues { all { onAny { severity("warn") } } }
}

subprojects {
    repositories {
        mavenCentral()
    }
}
```

---

## `backend/build.gradle`

```groovy
plugins {
    java
    application
    alias(libs.plugins.shadow)
    alias(libs.plugins.test.logger)
    alias(libs.plugins.spotless)
    alias(libs.plugins.openrewrite)
    alias(libs.plugins.errorprone)
}

group   = "machinum"
version = "1.0.0"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(libs.versions.java.get().toInteger())
    }
}

dependencies {
    // Jooby
    implementation libs.jooby.core
    implementation libs.jooby.netty
    implementation libs.jooby.jackson

    // CLI
    implementation libs.picocli

    // YAML
    implementation libs.snakeyaml

    // Groovy scripting
    implementation libs.groovy.core
    implementation libs.groovy.jsr223

    // JSON
    implementation libs.jackson.databind
    implementation libs.jackson.yaml

    // Docker
    implementation libs.docker.core
    implementation libs.docker.transport

    // Logging
    implementation libs.logback.classic
    implementation libs.slf4j.api

    // Utilities
    implementation libs.commons.lang3
    implementation libs.commons.io

    // Testing
    testImplementation libs.junit.jupiter
    testImplementation libs.assertj
    testImplementation libs.mockito

    // Error-prone + NullAway (compile-time null-safety)
    errorprone "com.google.errorprone:error_prone_core:2.26.1"
    errorprone "com.uber.nullaway:nullaway:${libs.versions.nullaway.get()}"
}

application {
    mainClass = "machinum.cli.MachinumCli"
}

tasks.withType(Test) {
    useJUnitPlatform()
}

tasks.withType(JavaCompile).configureEach {
    options.errorprone {
        check("NullAway", net.ltgt.gradle.errorprone.CheckSeverity.ERROR)
        option("NullAway:AnnotatedPackages", "machinum")
    }
}

// ./gradlew spotlessApply
spotless {
    java {
        prettier()
        removeUnusedImports()
        trimTrailingWhitespace()
        endWithNewline()
    }
    groovyGradle {
        trimTrailingWhitespace()
        endWithNewline()
    }
}

// ./gradlew rewriteRun   (auto-fix)
// ./gradlew rewriteDryRun (preview)
rewrite {
    activeRecipe(
        "org.openrewrite.java.cleanup.CommonStaticAnalysis",
        "org.openrewrite.java.RemoveUnusedImports",
        "org.openrewrite.java.OrderImports"
    )
    exclusion("**/generated/**")
}

dependencies {
    rewrite "org.openrewrite.recipe:rewrite-migrate-java:2.21.0"
    rewrite "org.openrewrite.recipe:rewrite-static-analysis:1.16.0"
}

tasks.shadowJar {
    archiveClassifier = ""
    mergeServiceFiles()
    manifest { attributes["Main-Class"] = application.mainClass }
}
```

---

## `frontend/build.gradle`

> **NOTE:** The project contains a frontend (e.g. React/Vue). This subproject delegates all build steps to **Yarn**. Gradle orchestrates it so that `./gradlew build` or `./gradlew assemble` transparently drives the full stack.

```groovy
/**
 * Frontend subproject — delegates to Yarn.
 *
 * Requires Node.js + Yarn to be available on PATH, or configure via
 * com.github.node-gradle.node plugin for hermetic builds (see below).
 *
 * Key tasks:
 *   yarnInstall  – install node_modules
 *   yarnBuild    – production build  (output → frontend/dist)
 *   yarnTest     – run frontend tests
 *   yarnLint     – run eslint / prettier checks
 *   clean        – wipe dist & node_modules cache
 */

plugins {
    base  // provides assemble / clean lifecycle hooks
    // Optional: hermetic Node.js — pin version without relying on PATH
    // id "com.github.node-gradle.node" version "7.0.2"
}

// ── If using node-gradle plugin (recommended for CI) ─────────────────────────
// node {
//     version          = "20.14.0"
//     npmVersion       = ""          // use bundled npm (yarn is invoked directly)
//     yarnVersion      = "1.22.22"
//     download         = true        // download node locally; no global install needed
//     workDir          = layout.projectDirectory.dir(".gradle/nodejs")
//     nodeProjectDir   = layout.projectDirectory    // package.json location
// }

def frontendDir = projectDir

def yarn(String... args) {
    exec {
        commandLine "yarn", args
        workingDir = frontendDir
    }
}

def yarnInstall = tasks.register("yarnInstall") {
    description = "Install frontend dependencies via Yarn"
    group       = "frontend"
    inputs.file("$frontendDir/package.json")
    inputs.file("$frontendDir/yarn.lock")
    outputs.dir("$frontendDir/node_modules")
    doLast { yarn("install", "--frozen-lockfile") }
}

def yarnBuild = tasks.register("yarnBuild") {
    description = "Build frontend for production"
    group       = "frontend"
    dependsOn yarnInstall
    inputs.dir("$frontendDir/src")
    outputs.dir("$frontendDir/dist")
    doLast { yarn("build") }
}

def yarnTest = tasks.register("yarnTest") {
    description = "Run frontend tests"
    group       = "frontend"
    dependsOn yarnInstall
    doLast { yarn("test", "--ci", "--passWithNoTests") }
}

def yarnLint = tasks.register("yarnLint") {
    description = "Lint frontend sources"
    group       = "frontend"
    dependsOn yarnInstall
    doLast { yarn("lint") }
}

tasks.assemble  { dependsOn yarnBuild }
tasks.check     { dependsOn yarnTest, yarnLint }
tasks.clean     { doLast { delete("$frontendDir/dist") } }
```

---

## Plugin Summary

| Plugin                                     | Purpose                                       | Key Task            |
|--------------------------------------------|-----------------------------------------------|---------------------|
| `com.github.johnrengelman.shadow`          | Fat/uber JAR                                  | `shadowJar`         |
| `com.adarshr.test-logger`                  | Pretty test output                            | auto                |
| `com.diffplug.spotless`                    | Code formatting (google-java-format + ktlint) | `spotlessApply`     |
| `org.openrewrite.rewrite-gradle-plugin`    | Automated refactoring & migration             | `rewriteRun`        |
| `net.ltgt.errorprone`                      | Compile-time bug detection + NullAway         | compile             |
| `com.github.ben-manes.versions`            | Detect outdated dependencies                  | `dependencyUpdates` |
| `com.autonomousapps.dependency-analysis`   | Find unused/misscoped deps                    | `buildHealth`       |
| `com.github.node-gradle.node` *(optional)* | Hermetic Node.js/Yarn for frontend            | `yarn_*`            |