# Implementation Plan

> **Last Updated:** 2026-05-10
> **Active Phase:** 8 — Tools `todo`

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
| ID   | Title                                    | Status | Size | Module              | UC ref      | Blocked By     | Blocks | Plan Link                                                  |
|------|------------------------------------------|--------|------|---------------------|-------------|----------------|--------|------------------------------------------------------------|
| T058 | HTTP→JSONL sample integration test       | `done` | `M`  | samples             | —           | —              | —      | [plans/http-jsonl-sample.md](plans/http-jsonl-sample.md)   |
| T059 | Implement chapter-validator tool         | `done` | `M`  | `packages/tools`    | UC-55       | —              | T065   | [plans/chapter-processing.md](plans/chapter-processing.md) |
| T060 | Implement token-splitter tool            | `done` | `M`  | `packages/tools`    | UC-56       | —              | T065   | [plans/chapter-processing.md](plans/chapter-processing.md) |
| T061 | Implement chapter-warnings tools         | `done` | `L`  | `packages/tools`    | UC-57       | —              | T065   | [plans/chapter-processing.md](plans/chapter-processing.md) |
| T062 | Implement chapter-fixer tools            | `done` | `L`  | `packages/tools`    | UC-58       | —              | T065   | [plans/chapter-processing.md](plans/chapter-processing.md) |
| T063 | Implement title-translator batch tool    | `done` | `M`  | `packages/tools`    | UC-59       | —              | T065   | [plans/chapter-processing.md](plans/chapter-processing.md) |
| T064 | Implement paragraph-translator tool      | `done` | `M`  | `packages/tools`    | UC-60       | —              | T065   | [plans/chapter-processing.md](plans/chapter-processing.md) |
| T065 | Wire tools into chapter-processing pipes | `done` | `L`  | `samples/sample2`   | UC-59,UC-60 | T059..T064     | T068   | [plans/chapter-processing.md](plans/chapter-processing.md) |
| T066 | Fix translate endpoint + OpenRouter pool | `done` | `M`  | `packages/router`   | UC-61,UC-62 | —              | T068   | [plans/chapter-processing.md](plans/chapter-processing.md) |
| T067 | Add chapter-output waypoint scheme       | `done` | `M`  | `packages/waypoint` | UC-59       | —              | T068   | [plans/chapter-processing.md](plans/chapter-processing.md) |
| T068 | Integration test: chapter-processing     | `done` | `L`  | `samples/sample2`   | UC-55..60   | T065,T066,T067 | —      | [plans/chapter-processing.md](plans/chapter-processing.md) |

> `UC ref` column which contains an ID of the use case, located at `docs/uc.md`

## Phase Summary
| Phase                   | Status | Tasks     | Documentation                          |
|-------------------------|--------|-----------|----------------------------------------|
| 1 — Engine Spine (M1)   | `done` | T001–T010 | [uc.md](uc.md), [steering/](steering/) |
| 2 — CLI Completion      | `done` | T011–T030 | [uc.md](uc.md)                         |
| 3 — Admin UI & Policies | `done` | T031–T035 | [uc.md](uc.md)                         |
| 4 — Architectural Tests | `done` | T036–T051 | [plans/](plans/)                       |
| 5 — Module Ecosystem    | `done` | T052–T056 | [uc.md](uc.md)                         |
| 6 — Polish & Remaining  | `done` | T057–T057 | [uc.md](uc.md)                         |
| 7 — Sample Projects     | `done` | T058–T068 | [plans/](plans/)                       |
| 8 — Tools               | `todo` | T069–?    | [plans/](plans/)                       |
