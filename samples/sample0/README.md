# Sample 0 — mt init Integration Test

This sample verifies that `mt init` correctly scaffolds a new project.

## What you will learn

- How `mt init <name>` creates `mt.json`, `.mt/` directory structure, and a sample pipeline.
- How the integration test validates every scaffolded artifact.

## Directory layout

```
samples/sample0/
        ├── tests/init.test.ts           # Vitest integration test
        ├── mt.json                      # Project configuration (created by mt init)
        └── vitest.config.ts             # Vitest config
```

## How to run

```bash
cd samples/sample0
npm run example
```

This runs `mt init sample-project` directly using the workspace-linked dependencies.

## How to clean up

```bash
cd samples/sample0
npm run cleanup
```

This removes the scaffolded `sample-project` directory, `.mt/`, and `node_modules/`.

## How to run manually

```bash
cd samples/sample0

# 1. Run mt init
npx mt init sample-project

# 2. Inspect the output
cat mt.json
ls -la .mt/
cat pipelines/example.ts
```

## How the test works

The vitest test (`tests/init.test.ts`) runs `mt init` in the sample directory,
then asserts that `mt.json`, `.mt/runs/`, `.mt/cache/`, and `pipelines/example.ts`
all exist with correct content. Cleanup runs automatically in `afterAll`.
