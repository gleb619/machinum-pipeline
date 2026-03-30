# Project Structure: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

## 1. Workspace Directory Structure

> **Related:** [CLI Commands §install](cli-commands.md#install), [YAML Schema §3](yaml-schema.md#3-tools-yaml-mttoolsyaml)

```
work-directory/
├── seed.yaml                        # Root user configuration (also: root.yml|yaml)
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
├── ui/                                  # Planned
│   ├── admin-ui/
│   ├── vscode-extension/
│   └── shared-components/
└── mcp/
    └── src/main/java/machinum/mcp/
```

---

## 3. Build Configuration

See [build-configuration.md](build-configuration.md) for full details.
