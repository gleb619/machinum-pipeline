# CLAUDE.md

## PRIME DIRECTIVE: Spec-Driven Development

This project uses **Spec-Driven Development** via [github/spec-kit](https://github.com/github/spec-kit).

**You must NEVER write implementation code before a spec exists for the feature being built.**

---

## Workflow — Always Follow This Order

When the user asks you to build, change, or add anything:

### 1. Check for an existing spec

Look in `.specify/specs/` for a spec directory matching the feature.

```
.specify/specs/
  001-<feature-name>/
    spec.md          ← requirements + user stories
    plan.md          ← technical implementation plan
    tasks.md         ← ordered task breakdown
    data-model.md
    research.md
    contracts/
```

If `.specify/` does not exist → tell the user to run:
```
specify init . --ai claude
```
and stop until that's done.

---

### 2. No spec for this feature? Create one first.

Run the spec workflow in order:

| Step | Command                          | Purpose                                |
|------|----------------------------------|----------------------------------------|
| 2a   | `/speckit.constitution`          | Establish or update project principles |
| 2b   | `/speckit.specify <description>` | Write requirements & user stories      |
| 2c   | `/speckit.clarify`               | Fill gaps before planning              |
| 2d   | `/speckit.plan <tech stack>`     | Technical plan + data model            |
| 2e   | `/speckit.analyze`               | Cross-artifact consistency check       |
| 2f   | `/speckit.tasks`                 | Ordered, dependency-aware task list    |
| 2g   | `/speckit.implement`             | Execute tasks and write code           |

**Do not skip or reorder steps.** Each output feeds the next.

---

### 3. Spec exists — read it before doing ANYTHING

Before touching code:
1. Read `.specify/specs/<feature>/spec.md` fully
2. Read `.specify/specs/<feature>/plan.md` if present
3. Read `.specify/specs/<feature>/tasks.md` if present
4. Read `.specify/memory/constitution.md` for project principles

Your implementation must conform to what is written there.  
If the user's request contradicts the spec → surface the conflict and ask which to trust.

---

### 4. Implementing a task

- Work through `tasks.md` top-to-bottom
- Respect `[P]` markers (parallel-safe tasks)
- Do not implement tasks out of order unless explicitly told to
- After each task group / checkpoint, validate and report status
- If a task is ambiguous → run `/speckit.clarify` before proceeding

---

### 5. Updating specs

If requirements change mid-implementation:
1. Update `spec.md` first
2. Re-run `/speckit.plan` if the technical approach changes
3. Re-run `/speckit.tasks` to regenerate the task list
4. Then continue with `/speckit.implement`

**Never silently diverge from the spec while coding.**

---

## File Structure Reference

```
.specify/
  memory/
    constitution.md     ← project principles, always read first
  specs/
    <NNN>-<feature>/
      spec.md
      plan.md
      tasks.md
      data-model.md
      research.md
      quickstart.md
      contracts/
        api-spec.json
        signalr-spec.md   (or similar)
  templates/
    spec-template.md
    plan-template.md
    tasks-template.md
CLAUDE.md               ← this file
AGENTS.md               ← same rules for other agents
```

---

## Decision Rules (Quick Reference)

| Situation                           | Action                                                           |
|-------------------------------------|------------------------------------------------------------------|
| User asks to "build X" with no spec | Run `/speckit.specify` first                                     |
| Spec exists but is unclear          | Run `/speckit.clarify`                                           |
| Plan is missing                     | Run `/speckit.plan`                                              |
| Tasks not generated                 | Run `/speckit.tasks`                                             |
| Ready to code                       | Run `/speckit.implement`                                         |
| Request contradicts spec            | Surface the conflict, ask user                                   |
| Spec needs updating                 | Update spec → re-plan → re-task → implement                      |
| User wants a quick hack / no spec   | Remind them of the rule; comply only if they explicitly override |

---

## What You Must NOT Do

- ❌ Write implementation code without reading the spec first
- ❌ Invent requirements not in `spec.md`
- ❌ Skip `/speckit.tasks` and implement directly from the plan
- ❌ Modify `constitution.md` without using `/speckit.constitution`
- ❌ Create files outside the spec-kit directory structure without a plan entry

---

## Constitution

Always read `.specify/memory/constitution.md` at the start of every session.  
It contains the non-negotiable technical and quality principles for this project.  
If it doesn't exist yet → your first action should be:

```
/speckit.constitution <describe project principles>
```
