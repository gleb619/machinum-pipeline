# Sample 0 — mt init Integration Test

This sample verifies that `mt init` correctly scaffolds a new project.

## What you will learn

- How `mt init <name>` creates `mt.json`, `.mt/` directory structure, and a sample pipeline.
- How the integration test validates every scaffolded artifact.

## Directory layout

```
samples/sample0/
        ├── tests/init.test.ts           # Vitest integration test
        ├── mt.json                      # Project configuration
        ├── vitest.config.ts             # Vitest config
        └── vendor/                      # Created at runtime — local tarballs
```

## How to run

```bash
cd samples/sample0
npm run example
```

This packs local dependencies, installs them, and runs `mt init sample-project`.

## How to clean up

```bash
cd samples/sample0
npm run cleanup
```

This removes the scaffolded `sample-project` directory, `vendor/`, `package-lock.json`, and `node_modules/`.

## How to run manually (no cleanup)

```bash
cd samples/sample0

# 1. Pack local dependencies
pnpm -C ../../packages/core pack --pack-destination ./vendor
pnpm -C ../../packages/cli pack --pack-destination ./vendor

# 2. Install them
npm install --no-audit --no-fund

# 3. Run mt init in a temp directory
npx mt init sample-project --out /tmp/mt-init-test

# 4. Inspect the output
ls -la /tmp/mt-init-test/
cat /tmp/mt-init-test/mt.json
ls -la /tmp/mt-init-test/.mt/
cat /tmp/mt-init-test/pipelines/example.ts
```

## How the test works

The vitest test (`tests/init.test.ts`) automates the steps above:
packs core and CLI, installs them, runs `mt init`, then asserts that `mt.json`, `.mt/runs/`, `.mt/cache/`, and
`pipelines/example.ts` all exist with correct content. Cleanup runs automatically in `afterAll`.
