# Machinum Pipeline Development Plan

**Last Updated**: 2026-03-25  
**Status**: Phase 1 Complete ✅ | Phase 2 Ready to Start

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

## Phase 1: MVP Foundation ✅ COMPLETE

**Branch**: `001-phase1-mvp-foundation`  
**Status**: ✅ **COMPLETE** - All 33 tasks delivered  
**Spec**: `specs/001-phase1-mvp-foundation/`

### Summary

| Category                          | Tasks  | Status         |
|-----------------------------------|--------|----------------|
| Setup (Infrastructure)            | 4      | ✅ Complete     |
| Foundational (Blocking)           | 8      | ✅ Complete     |
| User Story 1 - Pipeline Execution | 6      | ✅ Complete     |
| User Story 2 - Resume Flow        | 5      | ✅ Complete     |
| User Story 3 - CLI Operations     | 7      | ✅ Complete     |
| Polish & Cross-Cutting            | 3      | ✅ Complete     |
| **Total**                         | **33** | **✅ Complete** |

### Key Deliverables

- ✅ Gradle multi-module structure (core, cli, server)
- ✅ YAML manifest loading and validation
- ✅ Internal tool registry
- ✅ Sequential state machine execution
- ✅ Checkpoint/resume persistence
- ✅ CLI commands: `run`, `help`, `status`, `logs`
- ✅ Structured logging with correlation IDs
- ✅ Environment file loading
- ✅ Integration test coverage for all user stories

### Detailed Task List

All Phase 1 tasks are documented in: `docs/tasks/001-phase1-mvp-foundation.md`

**Result Documentation**: See `docs/results/001-phase1-mvp-foundation.result.md` for completion summary.

---

## Phase 2: External Tools & Workspace Management

**Branch**: `002-external-tools-support`  
**Status**: 🟡 **READY TO START** - Specs complete, implementation pending  
**Spec**: `docs/tasks/002-external-tools-support.md`  
**Estimated Effort**: ~56.5 hours (28 tasks)

### Task Summary

| Phase                           | Tasks  | Status        |
|---------------------------------|--------|---------------|
| 0: Foundation & Setup           | 3      | ⏳ Pending     |
| 1: External Tool Implementation | 4      | ⏳ Pending     |
| 2: Expression Resolution        | 3      | ⏳ Pending     |
| 3: Workspace Initialization     | 5      | ⏳ Pending     |
| 4: Cleanup Command              | 4      | ⏳ Pending     |
| 5: Integration & Testing        | 6      | ⏳ Pending     |
| 6: Documentation & Polish       | 3      | ⏳ Pending     |
| **Total**                       | **28** | **⏳ Pending** |

### Detailed Task Table

#### Phase 0: Foundation & Setup

| ID  | Task                                | Priority | Depends | Status | Details                                     |
|-----|-------------------------------------|----------|---------|--------|---------------------------------------------|
| 0.1 | Add Groovy Dependency               | P0       | None    | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 0.2 | Create ExpressionResolver Interface | P0       | 0.1     | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 0.3 | Create ExpressionContext Class      | P0       | 0.2     | ⏳      | `docs/tasks/002-external-tools-support.md` |

#### Phase 1: External Tool Implementation

| ID  | Task                           | Priority | Depends  | Status | Details                                     |
|-----|--------------------------------|----------|----------|--------|---------------------------------------------|
| 1.1 | Create ExternalTool Base Class | P0       | 0.1      | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 1.2 | Implement ShellTool            | P0       | 1.1      | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 1.3 | Implement GroovyScriptTool     | P0       | 1.1, 0.3 | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 1.4 | Add Script Path Validation     | P1       | 1.2, 1.3 | ⏳      | `docs/tasks/002-external-tools-support.md` |

#### Phase 2: Expression Resolution

| ID  | Task                                       | Priority | Depends       | Status | Details                                     |
|-----|--------------------------------------------|----------|---------------|--------|---------------------------------------------|
| 2.1 | Implement GroovyExpressionResolver         | P0       | 0.2, 0.3, 1.3 | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 2.2 | Support Script-Based Expressions           | P1       | 2.1, 1.3      | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 2.3 | Integrate ExpressionResolver into Pipeline | P0       | 2.1           | ⏳      | `docs/tasks/002-external-tools-support.md` |

#### Phase 3: Workspace Initialization

| ID  | Task                              | Priority | Depends  | Status | Details                                     |
|-----|-----------------------------------|----------|----------|--------|---------------------------------------------|
| 3.1 | Create WorkspaceLayout Class      | P0       | None     | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 3.2 | Create WorkspaceInitializerTool Class | P0       | 3.1      | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 3.3 | Implement Package.json Generation | P1       | 3.2      | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 3.4 | Create InstallCommand CLI         | P0       | 3.2, 3.3 | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 3.5 | Create Template Files             | P1       | 3.2      | ⏳      | `docs/tasks/002-external-tools-support.md` |

#### Phase 4: Cleanup Command

| ID  | Task                       | Priority | Depends  | Status | Details                                     |
|-----|----------------------------|----------|----------|--------|---------------------------------------------|
| 4.1 | Create CleanupPolicy Class | P1       | None     | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 4.2 | Create RunScanner Utility  | P1       | 4.1      | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 4.3 | Implement Cleanup Logic    | P1       | 4.1, 4.2 | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 4.4 | Create CleanupCommand CLI  | P1       | 4.3      | ⏳      | `docs/tasks/002-external-tools-support.md` |

#### Phase 5: Integration & Testing

| ID  | Task                                    | Priority | Depends      | Status | Details                                     |
|-----|-----------------------------------------|----------|--------------|--------|---------------------------------------------|
| 5.1 | Write ShellTool Integration Test        | P0       | 1.2          | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 5.2 | Write GroovyScriptTool Integration Test | P0       | 1.3          | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 5.3 | Write ExpressionResolver Tests          | P0       | 2.1, 2.2     | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 5.4 | Write Workspace Init Integration Test   | P1       | 3.4, 3.3     | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 5.5 | Write Cleanup Integration Test          | P1       | 4.4          | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 5.6 | Write End-to-End Pipeline Test          | P0       | All previous | ⏳      | `docs/tasks/002-external-tools-support.md` |

#### Phase 6: Documentation & Polish

| ID  | Task                    | Priority | Depends        | Status | Details                                     |
|-----|-------------------------|----------|----------------|--------|---------------------------------------------|
| 6.1 | Update Quickstart Guide | P1       | All impl       | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 6.2 | Create Example Scripts  | P1       | 1.2, 1.3       | ⏳      | `docs/tasks/002-external-tools-support.md` |
| 6.3 | Update TDD if Needed    | P2       | Implementation | ⏳      | `docs/tasks/002-external-tools-support.md` |

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
