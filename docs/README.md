# Docs layout

Two audiences, two doc sets:

| Dir | Audience | Purpose |
|---|---|---|
| [steering/](steering/) | **Coding agents** | Development docs — read the relevant steering file *before editing* a package (API contracts, conventions, invariants, test rules). Concise, prescriptive, maintained alongside code. |
| [guiding/](guiding/) | **Humans** | Project explanation — what machinum-pipeline is, how it works, how to install/run/extend it (architecture, use cases, tools catalogue, samples, vault, onboarding, lifecycle). Descriptive, readable top to bottom. |

Also here: [SKILL.md](SKILL.md) — the agent skill for projects that *use* `mt` (embedded in the binary; `mt skill` prints/installs it). Keep it in sync with big changes (see AGENTS.md hard rules).

Also here: [install.sh](install.sh) — installer (binary / `--docker` / `--from-source`; see [guiding/installation.md](guiding/installation.md)). Repo-root `Dockerfile` + `docker/entrypoint.sh` build the image; `.github/workflows/{ci,release}.yml` run CI and releases.

Everything else in this directory:

- Flow docs (repo root): [kanban.md](kanban.md) (task board), [kanban-loop.md](kanban-loop.md), [kanban-compose.md](kanban-compose.md), [kanban-feeder-loop.md](kanban-feeder-loop.md) (automated loops), [change-workflow.md](change-workflow.md) (worktree → branch → gates → FF-merge lifecycle).
- [plans/](plans/) — design/plan documents per task.
- [features/](features/), [ideas/](ideas/), [locks/](locks/), [superpowers/](superpowers/) — incubation and scratch space.

Rule of thumb: agent about to change code → `steering/`; human asking "how does this project work?" → `guiding/`.
