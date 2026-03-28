# Task: 6.3-update-tdd

**Phase**: 6
**Priority**: P2
**Status**: `pending`
**Depends On**: All implementation tasks complete
**TDD Reference**: `docs/tdd.md`

---

## Description

Review and update the Technical Design Document (TDD) to reflect any architectural decisions, implementation details, or
deviations from the original plan that occurred during the implementation of external tools and workspace management
features.

---

## Acceptance Criteria

- [ ] Review implementation against original TDD
- [ ] Update TDD sections that changed during implementation
- [ ] Document any deviations from original plan
- [ ] Add new sections for features added but not in original TDD
- [ ] Update diagrams if architecture changed
- [ ] Update code examples to match actual implementation
- [ ] Update references to classes and packages
- [ ] Verify all links and cross-references are correct
- [ ] Update constitution if needed

---

## Implementation Notes

### Areas to Review

**1. External Tools Architecture (Section 5.1)**

- Verify `ExternalTool` base class design matches TDD
- Check `ShellTool` and `GroovyScriptTool` implementations
- Update if actual implementation differs from design

**2. Expression Resolution (Section 5.2)**

- Verify `ExpressionResolver` interface matches implementation
- Check `DefaultExpressionResolver` implementation details
- Update script-based expression documentation
- Verify `ExpressionContext` fields match implementation

**3. Workspace Initialization (Section 7.1)**

- Verify `WorkspaceLayout` class design
- Check `WorkspaceInitializerTool` implementation
- Update directory structure if changed
- Verify template file locations

**4. Cleanup Command (Section 7.2)**

- Verify `CleanupPolicy` fields and behavior
- Check `RunScanner` implementation
- Update retention policy documentation
- Verify CLI options match implementation

**5. Script Registry (New Feature)**

- Add new section for `ScriptRegistry` class
- Document script organization by type
- Document script-based expression syntax
- Add examples for script invocation

### Potential Updates

Based on implementation analysis, these sections may need updates:

**ExpressionContext Variables**:

```java
// Verify these match implementation:
-item:Map<String, Object>
-text:String
-index:int
-textLength:int
-textWords:int
-textTokens:int
-aggregationIndex:int
-aggregationText:String
-runId:String
-state:StateDefinition
-tool:ToolDefinition
-retryAttempt:int
-env:Map<String, String>
-variables:Map<String, Object>
-scripts:ScriptRegistry  // NEW: Add if not in TDD
```

**Script-Based Expressions**:

```groovy
// Add documentation for this new feature:
{
  {
    scripts.conditions.is_valid(item)
  }
}
{
  {
    scripts.transformers.normalize()
  }
}
{
  {
    scripts.validators.has_content(arg)
  }
}
```

**Tool Configuration**:

```yaml
# Verify these examples match actual implementation:
tools:
  - name: shell-tool
    type: shell
    runtime: shell
    script: path/to/script.sh
    args: [ "--verbose" ]
    env:
      VAR: value
    timeout: 30s

  - name: groovy-tool
    type: groovy
    runtime: groovy
    script: path/to/script.groovy
    return-type: Boolean
    sandboxed: true
    timeout: 30s
```

---

## Resources

**Files to Update**:

- `docs/tdd.md` - Main TDD document

**Files to Read**:

- `core/src/main/java/machinum/expression/DefaultExpressionResolver.java`
- `core/src/main/java/machinum/expression/ExpressionContext.java`
- `core/src/main/java/machinum/expression/ScriptRegistry.java`
- `tools/common/src/main/java/machinum/tool/ExternalTool.java`
- `tools/external/src/main/java/machinum/tool/ShellTool.java`
- `tools/external/src/main/java/machinum/tool/GroovyScriptTool.java`
- `tools/internal/src/main/java/machinum/workspace/WorkspaceLayout.java`
- `tools/internal/src/main/java/machinum/workspace/WorkspaceInitializerTool.java`
- `core/src/main/java/machinum/cleanup/CleanupPolicy.java`
- `core/src/main/java/machinum/cleanup/RunScanner.java`

---

## Spec

### TDD Sections to Review

**Section 4: Architecture**

- External tool architecture
- Expression resolution flow
- Workspace structure

**Section 5: Core Features**

- 5.1 External Tools (update with actual implementation)
- 5.2 Expression Resolution (add ScriptRegistry)
- 5.3 Tool Registry (verify unchanged)

**Section 7: Workspace Management**

- 7.1 Workspace Initialization (update with actual implementation)
- 7.2 Cleanup Command (update with actual implementation)

### Checklists

**Review Checklist**:

- [ ] All class names match implementation
- [ ] All method signatures match implementation
- [ ] All package names are correct
- [ ] All code examples compile
- [ ] All cross-references are valid
- [ ] All diagrams are accurate
- [ ] All user stories are addressed

### Plan

1. **Read current TDD** thoroughly
2. **Review implementation** files for each section
3. **Identify discrepancies** between TDD and implementation
4. **Update Section 5.1** (External Tools)
5. **Update Section 5.2** (Expression Resolution)
6. **Add Section 5.3** (Script Registry - if new)
7. **Update Section 7.1** (Workspace Initialization)
8. **Update Section 7.2** (Cleanup Command)
9. **Review Section 4** (Architecture diagrams)
10. **Update constitution** if needed
11. **Verify all changes** are consistent

### Quickstart

- `docs/tdd.md` - Current TDD to update
- `docs/plan.md` - Development plan for context
- `specs/002-external-tools-support/spec.md` - Original specification

---

## TDD Update Process

### 1. Compare Implementation to TDD

Read each TDD section and compare with actual implementation

### 2. Document Deviations

Note any differences between design and implementation

### 3. Update TDD

Modify TDD to accurately reflect implementation

### 4. Add Missing Sections

Add documentation for features not in original TDD

### 5. Review and Validate

Ensure TDD is accurate and complete

---

## Result

Link to: `docs/results/6.3-update-tdd.result.md`
