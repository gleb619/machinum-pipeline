# Machinum Pipeline Development Plan

**Last Updated**: 2026-03-27
**Status**: Phase 0-4 Complete ✅ | Phase 5-6 In Progress

---

## Overview

This document provides a centralized view of all development tasks for the Machinum Pipeline project. Tasks are
organized by phase with status tracking and links to detailed specifications.

### How to Use This Plan

1. **Read `docs/tdd.md` first** - Understand the technical design and architecture
2. **Check task status** - Find available tasks (status: `pending`)
3. **Block your task** - Update status to `in_progress` to prevent conflicts
4. **Read detailed spec** - Navigate to `specs/{phase}/tasks.md` for full task description
5. **Work in sessions** - Large tasks may require multiple sessions
6. **Document results** - Create `docs/results/{task-name}.result.md` after completion

---

## Consolidated Development Plan

**Current Status**: Work in Progress

### Unified Task Table

| Phase | ID  | Task                                | Priority | Depends        | Status     | Effort | Details                                                    |
|-------|-----|-------------------------------------|----------|----------------|------------|--------|------------------------------------------------------------|
| 1     | -   | MVP Foundation (33 tasks)           | -        | -              | ✅ Complete | -      | `docs/tasks/001-phase1-mvp-foundation.md`                  |
| 2     | 0.1 | Add Groovy Dependency               | P0       | None           | ✅ Complete | 1h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 0.2 | Create ExpressionResolver Interface | P0       | 0.1            | ✅ Complete | 2h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 0.3 | Create ExpressionContext Class      | P0       | 0.2            | ✅ Complete | 2h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 1.1 | Create ExternalTool Base Class      | P0       | 0.1            | ✅ Complete | 3h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 1.2 | Implement ShellTool                 | P0       | 1.1            | ✅ Complete | 4h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 1.3 | Implement GroovyScriptTool          | P0       | 1.1, 0.3       | ✅ Complete | 4h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 1.4 | Add Script Path Validation          | P1       | 1.2, 1.3       | ✅ Complete | 2h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 2.1 | Implement GroovyExpressionResolver  | P0       | 0.2, 0.3, 1.3  | ✅ Complete | 6h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 2.2 | Support Script-Based Expressions    | P1       | 2.1, 1.3       | ✅ Complete | 3h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 2.3 | Integrate ExpressionResolver        | P0       | 2.1            | ✅ Complete | 3h     | `docs/results/2.3-integrate-expression-resolver.result.md` |
| 2     | 3.1 | Create WorkspaceLayout Class        | P0       | None           | ✅ Complete | 2h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 3.2 | Create WorkspaceInitializerTool     | P0       | 3.1            | ✅ Complete | 3h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 3.3 | Implement Package.json Generation   | P1       | 3.2            | ✅ Complete | 3h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 3.4 | Create InstallCommand CLI           | P0       | 3.2, 3.3       | ✅ Complete | 4h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 3.5 | Create Template Files               | P1       | 3.2            | ✅ Complete | 2h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 4.1 | Create CleanupPolicy Class          | P1       | None           | ✅ Complete | 2h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 4.2 | Create RunScanner Utility           | P1       | 4.1            | ✅ Complete | 2h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 4.3 | Implement Cleanup Logic             | P1       | 4.1, 4.2       | ✅ Complete | 3h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 4.4 | Create CleanupCommand CLI           | P1       | 4.3            | ✅ Complete | 3h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 5.1 | Write ShellTool Integration Test    | P0       | 1.2            | ✅ Complete | 3h     | `docs/tasks/task-5.1-shelltool-integration-test.md`        |
| 2     | 5.2 | Write GroovyScriptTool Integration  | P0       | 1.3            | ⏳ Pending  | 3h     | `docs/tasks/task-5.2-groovyscripttool-integration-test.md` |
| 2     | 5.3 | Write ExpressionResolver Tests      | P0       | 2.1, 2.2       | ✅ Complete | 3h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 5.4 | Write Workspace Init Integration    | P1       | 3.4, 3.3       | ✅ Complete | 2h     | `docs/tasks/task-5.4-workspace-init-integration-test.md`   |
| 2     | 5.5 | Write Cleanup Integration Test      | P1       | 4.4            | ⏳ Pending  | 2h     | `docs/tasks/task-5.5-cleanup-integration-test.md`          |
| 2     | 5.6 | Write End-to-End Pipeline Test      | P0       | All previous   | ⏳ Pending  | 4h     | `docs/tasks/task-5.6-e2e-pipeline-test.md`                 |
| 2     | 6.1 | Update Quickstart Guide             | P1       | All impl       | ⏳ Pending  | 2h     | `docs/tasks/task-6.1-update-quickstart-guide.md`           |
| 2     | 6.2 | Create Example Scripts              | P1       | 1.2, 1.3       | ✅ Complete | 3h     | `docs/tasks/002-external-tools-support.md`                 |
| 2     | 6.3 | Update TDD if Needed                | P2       | Implementation | ⏳ Pending  | 1h     | `docs/tasks/task-6.3-update-tdd.md`                        |

### Summary

**Completed (22/28 tasks)**:

- ✅ Phase 0: Foundation (Groovy, ExpressionResolver, ExpressionContext)
- ✅ Phase 1: External Tools (ExternalTool, ShellTool, GroovyScriptTool, validation)
- ✅ Phase 2: Expression Resolution (DefaultExpressionResolver, ScriptRegistry, Pipeline Integration)
- ✅ Phase 3: Workspace Init (WorkspaceLayout, WorkspaceInitializerTool, InstallCommand)
- ✅ Phase 4: Cleanup (CleanupPolicy, RunScanner, CleanupService, CleanupCommand)
- ✅ Phase 5: ExpressionResolver tests written, Workspace Init integration test
- ✅ Phase 6: Example scripts created

**Remaining (6/28 tasks)**:

- ⏳ Task 5.1, 5.2, 5.5, 5.6: Integration and E2E tests
- ⏳ Task 6.1, 6.3: Documentation updates

---

## Quick Reference

### File Locations

| Purpose          | Location                   |
|------------------|----------------------------|
| Technical Design | `docs/tdd.md`              |
| Development Plan | `docs/plan.md` (this file) |
| Task Templates   | `docs/task.template.md`    |
| Result Templates | `docs/result.template.md`  |
| Tasks Docs       | `docs/tasks/`              |
| Result Docs      | `docs/results/`            |

### Status Legend

| Symbol | Meaning                                                  |
|--------|----------------------------------------------------------|
| ⏳      | Pending - Not started                                    |
| 🔄     | In Progress - Currently being worked on                  |
| ✅      | Complete - Finished and documented                       |
| 🚫     | Blocked - Cannot proceed due to dependency， dependencies |
| ❌      | Cancelled - Will not be implemented                      |
