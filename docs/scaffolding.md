# Implementation Plan

> **Last Updated:** 2026-05-03
> **Active Phase:** 4 — Architectural Tests — `todo`
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
| ID   | Title                                                 | Status | Size | Module         | UC ref                        | Blocked By | Blocks | Plan Link                                                    |
|------|-------------------------------------------------------|--------|------|----------------|-------------------------------|------------|--------|--------------------------------------------------------------|
| T031 | Start Run from Admin UI                               | `done` | `M`  | backend,ui     | UC-28                         | T025       | T032   | —                                                            |
| T032 | Pause/Resume Run from Admin UI                        | `done` | `M`  | backend,ui     | UC-31                         | T031       | —      | —                                                            |
| T033 | Configure retry/onError policies per pipeline/tool    | `done` | `M`  | core           | UC-47                         | —          | —      | —                                                            |
| T034 | Persist intermediate artifacts under Run dir          | `done` | `M`  | core           | UC-52                         | —          | —      | —                                                            |
| T035 | Mirror runs to SQLite (schema scaffold)               | `done` | `M`  | backend        | UC-54                         | T025       | —      | —                                                            |
| T036 | Architectural tests — Project Setup & Discovery       | `done` | `M`  | cli,core       | —                             | —          | —      | [plans/project-setup.md](plans/project-setup.md)             |
| T037 | Architectural tests — DSL Authoring & Extensibility   | `done` | `M`  | core           | —                             | —          | —      | [plans/dsl-authoring.md](plans/dsl-authoring.md)             |
| T038 | Architectural tests — CLI Execution & Lifecycle       | `done` | `M`  | cli,core       | —                             | —          | —      | [plans/cli-execution.md](plans/cli-execution.md)             |
| T039 | Architectural tests — Child-Process Tool Execution    | `todo` | `M`  | core           | —                             | —          | —      | [plans/child-process-tools.md](plans/child-process-tools.md) |
| T040 | Architectural tests — Parallelism, Batching & Forking | `todo` | `M`  | core           | —                             | —          | —      | [plans/parallelism.md](plans/parallelism.md)                 |
| T041 | Architectural tests — Engine Resilience               | `todo` | `M`  | core           | —                             | —          | —      | [plans/engine-resilience.md](plans/engine-resilience.md)     |
| T042 | Architectural tests — Item Routing                    | `todo` | `S`  | core           | —                             | —          | —      | [plans/item-routing.md](plans/item-routing.md)               |
| T043 | Architectural tests — Built-in Sources & Targets      | `todo` | `M`  | core           | —                             | —          | —      | [plans/builtin-io.md](plans/builtin-io.md)                   |
| T044 | Architectural tests — Git Worktrees & URI Composition | `todo` | `M`  | core           | —                             | —          | —      | [plans/git-uri-composition.md](plans/git-uri-composition.md) |
| T045 | Architectural tests — Background Serving              | `todo` | `M`  | cli,backend    | —                             | —          | —      | [plans/background-serve.md](plans/background-serve.md)       |
| T046 | Architectural tests — Admin UI, SSE & Backend API     | `todo` | `L`  | backend,ui     | —                             | —          | —      | [plans/admin-backend.md](plans/admin-backend.md)             |
| T047 | Architectural tests — LLM Router Proxy                | `todo` | `L`  | router         | —                             | —          | —      | [plans/llm-router.md](plans/llm-router.md)                   |
| T048 | Architectural tests — MCP Server                      | `todo` | `L`  | mcp            | —                             | —          | —      | [plans/mcp-server.md](plans/mcp-server.md)                   |
| T049 | Architectural tests — Chrome Extension                | `todo` | `M`  | chrome,backend | —                             | —          | —      | [plans/chrome-extension.md](plans/chrome-extension.md)       |
| T050 | Architectural tests — VSCode Extension                | `todo` | `M`  | vscode         | —                             | —          | —      | [plans/vscode-extension.md](plans/vscode-extension.md)       |
| T051 | Architectural tests — Storage & Logging               | `todo` | `M`  | core,cli       | —                             | —          | —      | [plans/storage-logging.md](plans/storage-logging.md)         |
| T052 | Router module — LLM proxy + dashboard + cost tracking | `todo` | `L`  | router         | UC-32,UC-33,UC-34,UC-35,UC-36 | —          | T047   | —                                                            |
| T053 | MCP server — list/run/inspect pipelines + tool invoke | `todo` | `L`  | mcp            | UC-37,UC-38,UC-39,UC-40,UC-41 | —          | T048   | —                                                            |
| T054 | Chrome extension — scrape chapters + auto-upload      | `todo` | `L`  | chrome         | UC-42,UC-43                   | —          | T049   | —                                                            |
| T055 | VSCode extension — validation + hover DSL + code lens | `todo` | `L`  | vscode         | UC-44,UC-45,UC-46             | —          | T050   | —                                                            |
| T056 | Complete HTTP Source — backend integration + SSE push | `todo` | `M`  | backend,core   | UC-23                         | T035       | —      | —                                                            |

> `UC ref` column which contains an ID of the use case, located at `docs/uc.md`

## Phase Summary
| Phase                   | Status | Tasks     | Documentation                          |
|-------------------------|--------|-----------|----------------------------------------|
| 1 — Engine Spine (M1)   | `done` | T001–T010 | [uc.md](uc.md), [steering/](steering/) |
| 2 — CLI Completion      | `done` | T011–T030 | [uc.md](uc.md)                         |
| 3 — Admin UI & Policies | `done` | T031–T035 | [uc.md](uc.md)                         |
| 4 — Architectural Tests | `todo` | T036–T051 | [plans/](plans/)                         |
| 5 — Module Ecosystem    | `todo` | T052–T056 | [uc.md](uc.md)                         |
