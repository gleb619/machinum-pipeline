# Project Structure: Machinum Pipeline

> **Part of:** [Technical Design Document Index](tdd.md)

## 1. Workspace Directory Structure

```
work-directory/
├── seed.yaml                        # Root user configuration (also: root.yml|yaml)
├── .mt/                             # Internal directory
│   ├── tools.yaml                   # Tool definitions
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

**Generation rules:**

- `machinum install` — shortcut for `download` → `bootstrap`
- `machinum install download` — resolves/fetches tool sources; MUST NOT mutate workspace layout
- `machinum install bootstrap` — creates default workspace (`.mt`, `src/main`, `build`) via internal tools; generates
  `package.json` if node tools are enabled

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
