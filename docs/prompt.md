## Task Continuation Prompt

### Instructions for LLM Agent

1. **READ FIRST**: Start by reading `docs/tdd.md` to understand the technical architecture and design decisions.

2. **READ PLAN**: Read `docs/plan.md` (this file) to understand the overall development plan and current status.

3. **SELECT TASK**: Choose a task with status `⏳ Pending` from Phase 2. Prefer tasks on the critical path (Phase 0 → 1 → 2 → 5).

4. **BLOCK TASK**: Immediately update `docs/plan.md` to change the task status from `⏳ Pending` to `🔄 In Progress` to prevent other agents from working on the same task.

5. **READ DETAILED SPEC**: Navigate to `docs/tasks/{task-name}.md` and read the full task description, acceptance
   criteria, and
   implementation notes.

6. **WORK IN SESSIONS**:
    - Large tasks may require multiple sessions
    - At the end of each session, document progress in a temporary file
    - Use that file to resume in the next session
    - If interrupted, leave clear notes about what was in progress

7. **AFTER COMPLETION**:
    - Create a result document at `docs/results/{task-name}.result.md`
    - Use the template at `docs/result.template.md`
    - Document:
        - What was done
        - Files created/modified/deleted
        - Testing performed
        - Links to PRs or related work
        - Any follow-ups or technical debt
    - Update `docs/plan.md` to mark task as `✅ Complete`
    - Link to the result document in the plan

8. **TEMPLATE USAGE**:
    - For new detailed task descriptions, use `docs/task.template.md`
    - For result documentation, use `docs/result.template.md`

### Example Task Selection

"I'm starting Task 0.1: Add Groovy Dependency"
→ Update status in plan: `⏳ Pending` → `🔄 In Progress`
→ Read: `docs/tasks/002-external-tools-support.md`
→ Implement: Add Groovy 4.0+ to build.gradle
→ Test: Verify build compiles
→ Document: Create `docs/results/002-external-tools-support.result.md`
→ Complete: Update plan status to `✅ Complete`