# Implementation Plan

> **Last Updated:** 2026-05-03
> **Active Phase:** 2 — CLI Completion — `in-progress`
> **Agent:** Hermes Agent (hand-applied)

## Status Legend
| Symbol        | Meaning                        |
|---------------|--------------------------------|
| `todo`        | Not started                    |
| `in-progress` | Active                         |
| `done`        | Completed                      |
| `blocked`     | Waiting on dependency          |
| `parked`      | Locked, excluded from planning |

## Complexity Legend
| Symbol | Meaning             | Route                                  |
|--------|---------------------|----------------------------------------|
| `S`    | < 30 min            | writing-plans skill                    |
| `M`    | 30 min – 2h         | writing-plans skill                    |
| `L`    | 2h+, multi-file     | requirements -> design -> tasks skills |
| `XL`   | Days, architectural | requirements -> design -> tasks skills |

## Task Table
| ID   | Title                                                                           | Status | Size | Module | UC ref | Blocked By | Blocks | Plan Link                                                  |
|------|---------------------------------------------------------------------------------|--------|------|--------|--------|------------|--------|------------------------------------------------------------|
| T016 | Implement `.flatMap` DSL operator                                               | `done` | `M`  | core   | UC-13  | —          | T017   | [plan](plans/2026-04-30_184800-T016-T020-dsl-operators.md) |
| T017 | Implement `.fork` DSL operator for nested pipelines                             | `done` | `L`  | core   | UC-14  | T016       | —      | [plan](plans/2026-04-30_184800-T016-T020-dsl-operators.md) |
| T018 | Implement `.tap` DSL operator                                                   | `done` | `S`  | core   | —      | T017       | —      | [plan](plans/2026-04-30_184800-T016-T020-dsl-operators.md) |
| T019 | Support child-process tools (`npx`/`deno`/`bun`) — stdio JSON envelope handling | `done` | `L`  | core   | UC-11  | T017       | —      | [plan](plans/2026-04-30_184800-T016-T020-dsl-operators.md) |
| T021 | Route failures to dead-letter queue (`dead-letter.jsonl`)                       | `done` | `M`  | core   | UC-19  | —          | T022   | —                                                          |
| T022 | Implement long-lived HTTP Source                                                | `done` | `L`  | core   | UC-23  | T021       | T023   | [plan](plans/T022-http-source.md)                          |
| T023 | Support Git worktree isolation for Source/Target                                | `done` | `XL` | core   | UC-24  | —          | —      | —                                                          |
| T024 | Auto-commit results on Target close                                             | `done` | `L`  | core   | UC-25  | T023       | —      | —                                                          |
| T025 | Implement `mt serve` backend with SSE progress                                  | `done` | `L`  | cli,backend | UC-26  | —          | —      | —                                                          |
| T026 | Pause running Run via CLI signal (SIGINT)                                       | `done` | `S`  | cli    | UC-07  | —          | —      | —                                                          |
| T027 | Process items in parallel with concurrency limiter                              | `todo` | `M`  | core   | UC-12  | —          | —      | —                                                          |
| T028 | Implement skip-item onError strategy                                            | `todo` | `S`  | core   | UC-18  | —          | —      | —                                                          |
| T029 | Start backend detached (`mt serve -d`)                                          | `todo` | `L`  | cli    | UC-27  | T025       | —      | —                                                          |
| T030 | Discover pipelines from mt.json                                                 | `todo` | `M`  | core   | UC-48  | —          | —      | —                                                          |

> `UC ref` column which contains an ID of the use case, located at `docs/uc.md`

## Phase Summary
| Phase                 | Status        | Tasks     | Documentation                          |
|-----------------------|---------------|-----------|----------------------------------------|
| 1 — Engine Spine (M1) | `done`        | T001–T010 | [uc.md](uc.md), [steering/](steering/) |
| 2 — CLI Completion    | `in-progress` | T011–T030 | [uc.md](uc.md)                         |
