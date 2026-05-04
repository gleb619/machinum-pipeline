# Implementation Plan

> **Last Updated:** 2026-05-04
> **Active Phase:** — Complete — `done`

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
| ID   | Title                              | Status | Size | Module  | UC ref | Blocked By | Blocks | Plan Link                                                |
|------|------------------------------------|--------|------|---------|--------|------------|--------|----------------------------------------------------------|
| T058 | HTTP→JSONL sample integration test | `done` | `M`  | samples | —      | —          | —      | [plans/http-jsonl-sample.md](plans/http-jsonl-sample.md) |

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
| 7 — Sample Projects     | `done` | T058-?    | [plans/](plans/)                       |
