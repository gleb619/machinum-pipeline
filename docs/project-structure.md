# Project Structure: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

## 1. Workspace Directory Structure

> **Related:** [CLI Commands §install](cli-commands.md#install), [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml)

```
work-directory/
├── seed.yaml                        # Root user configuration (also: root.yml|yaml)
├── .git/                            # Git repository (initialized by GitTool)
├── .githooks/                       # Git hooks (created during bootstrap)
│   └── commit-msg.sh                # Commit message validation hook
├── .mt/                             # Internal directory
│   ├── tools.yaml                   # Tool definitions (flat list, no states)
│   ├── scripts/                     # External Groovy scripts
│   │   ├── conditions/
│   │   ├── transformers/
│   │   └── validators/
│   ├── tools/                       # Tool cache
│   └── state/                       # Checkpoint state
│       └── {run-id}/
│           ├── checkpoint.json
│           ├── items.json           # Collection for run processing
│           ├── metadata.json
│           ├── cache.json           # Internal tool cache for text processing
│           ├── artifacts/
│           └── run-log-{run-id}.json
├── src/
│   └── main/
│       ├── chapters/                # Input payloads or source adapters
│       │   └── en/                  # Language tag
│       │       ├── chapter_001.md
│       │       └── chapter_NNN.md
│       └── manifests/
│           ├── pipeline-a.yaml      # Pipeline declaration with tag 'a'
│           └── pipeline-b.yaml      # Pipeline declaration with tag 'b'
├── package.json                     # Generated when node tools enabled in tools.yaml
└── build/                           # Processed results and final artifacts
```

**Git Integration:**
- `.git/` - Initialized by `GitTool` during bootstrap phase
- `.githooks/commit-msg.sh` - Validates commit messages follow GitLab convention
- Git hooks configured via `core.hooksPath` in `.git/config`

**.gitignore Rules:**
The `.mt/` directory is ignored by git except for `tools.yaml`:
```gitignore
.mt/
!.mt/tools.yaml
.mt/state/
.mt/tools/
.mt/scripts/
```

See [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml) for tools.yaml format.
  
> The `chapters/` directory serves dual purpose: as direct input when using `items` mode, or as a target for `source` preprocessors that acquire and convert external data. See [YAML Schema §4.x](yaml-schema.md#4x-source-vs-items--data-acquisition-layer).

**Generation rules:**

- `machinum setup` — shortcut for download + bootstrap; runs `install()` on all internal tools
- `machinum setup download` — resolves/fetches tool sources; MUST NOT mutate workspace layout
- `machinum setup bootstrap` — creates default workspace (`.mt`, `src/main`, `build`) via internal tools; generates
  `package.json` if node tools are enabled

**Tools Lifecycle:**
Each internal tool's `install(ExecutionContext)` method runs unconditionally during the install phase. Use this for:
- Downloading external dependencies
- Initializing tool state or caches
- Validating configuration
- Setting up required resources

See [YAML Schema §3.1](yaml-schema.md#31-tool-lifecycle) for lifecycle details.

---

## 2. Gradle Project Structure

> Module split reflects target architecture; docs may lead implementation during bootstrap.

```
machinum-pipeline/
├── build.gradle
├── settings.gradle
├── README.md
├── docs/
│   ├── tdd.md
│   └── build-configuration.md
├── core/
│   ├── src/main/java/machinum/
│   │   ├── pipeline/
│   │   ├── tool/
│   │   ├── state/
│   │   ├── yaml/
│   │   ├── groovy/
│   │   └── checkpoint/
│   └── src/test/java/
├── cli/
│   ├── src/main/java/machinum/cli/
│   └── src/test/java/
├── server/
│   ├── src/main/java/machinum/server/
│   ├── src/main/resources/webapp/
│   └── src/test/java/
├── tools/
│   ├── common/                          # Shared adapters, execution abstractions, contracts
│   ├── internal/                        # Built-in internal tools
│   │   ├── text/
│   │   ├── glossary/
│   │   └── notify/
│   └── external/                        # External wrappers (shell/docker/ssh)
└── ui/                                  # Planned
    ├── admin-ui/
    ├── vscode-extension/
    └── shared-components/
```

---

## 3. Build Configuration

See [build-configuration.md](build-configuration.md) for full details.

### 3.1 Built-in Mode: Gradle Configuration

Built-in mode enables the `core` module to load tools from `tools/internal` and `tools/external`
submodules at runtime without requiring pre-built JARs or a remote registry.

#### How It Works

When built-in mode is enabled, Gradle adds the tool submodules as `runtimeOnly` dependencies to the
`core` module. At runtime, [`BuiltInToolRegistry`](../tools/common/src/main/java/machinum/tool/BuiltInToolRegistry.java)
discovers tools via:

1. **Classpath scanning** — Uses `ServiceLoader<Tool>` to find all `Tool` implementations on the
   runtime classpath. This is the preferred method when `-PbuiltinToolsEnabled` is set.
2. **Gradle build output** — Falls back to scanning
   `tools/{internal,external}/build/libs/*.jar` if no tools are found on the classpath.

#### Enabling Built-in Mode

| Method              | Configuration                                           |
|---------------------|---------------------------------------------------------|
| **Gradle property** | `-PbuiltinToolsEnabled=true` |
| **Environment var** | `MT_BUILTIN_TOOLS_ENABLED=true` |
| **System property** | `-Dmachinum.builtin.tools=true`                         |
| **Auto-detect**     | `build.gradle` in project root → builtin mode           |

#### Gradle Dependency Graph (Built-in Mode Enabled)

```
  tools:common   (no project deps)
       ^
       |
  +----+----+
  |         |
tools:internal  tools:external
  |               |
  +-------+-------+
          |
        core    ◄── runtimeOnly project(':tools:internal')  (when -PbuiltinToolsEnabled)
                ◄── runtimeOnly project(':tools:external')  (when -PbuiltinToolsEnabled)
          |
         cli    ◄── implementation project(':tools:internal')
                ◄── implementation project(':tools:external')
```

> **Note:** The `cli` module always depends on `tools/internal` and `tools/external` via
> `implementation`. The `core` module only adds them as `runtimeOnly` when built-in mode is enabled.
> See [`core/build.gradle`](../core/build.gradle#L30-L62).

#### Registry Configuration in `tools.yaml`

```yaml
body:
  registry: classpath://default  # Uses BuiltInToolRegistry
  bootstrap:
    - git
    - workspace
```

See [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml) for tools manifest format,
[CLI Commands §builtin](cli-commands.md#builtin-mode-flags) for CLI usage.

---

## 4. Examples Folder

The [`examples/`](../examples/) folder at the project root contains working examples for testing and learning Machinum Pipeline:

```
examples/
├── sample-test/                       # Test setup/download/bootstrap commands
│   ├── seed.yaml                      # Root configuration
│   ├── .mt/
│   │   └── tools.yaml                 # Tool definitions
│   └── src/main/
│       ├── chapters/
│       │   └── 1.md                   # Sample input
│       └── manifests/
│           └── pipeline.yaml          # Test pipeline
└── expression-test/                   # Test expression resolver integration
    ├── seed.yaml
    ├── .mt/
    │   ├── tools.yaml
    │   └── scripts/                   # Groovy scripts
    └── src/main/
        ├── chapters/
        │   └── 1.md
        └── manifests/
            └── expression-test-pipeline.yaml
```

### Using Examples

Each example is a self-contained workspace that can be run independently:

```bash
# Setup example workspace
./gradlew :cli:run --args="setup -w ./examples/sample-test"

# Run pipeline
./gradlew :cli:run --args="run -p setup-test-pipeline -w ./examples/sample-test"

# Check results
ls examples/sample-test/build/
ls examples/sample-test/.mt/state/
```

### Available Examples

| Example           | Purpose                                                                  |
|-------------------|--------------------------------------------------------------------------|
| `setup-test`      | Test setup/download/bootstrap commands                                   |
| `expression-test` | Test expression resolver and Groovy scripts                              |
| `sample-test`     | Test sample chapters with `samples://default` source, nooptool, testtool |

See [CLI Commands](cli-commands.md) for command reference.
