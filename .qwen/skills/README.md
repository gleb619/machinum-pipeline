# Machinum Pipeline Qwen Skills

This directory contains Qwen Code skills specifically designed for the Machinum Pipeline project.

## Available Skills

### 1. java-cli-command

**Purpose**: Create Picocli-based CLI commands following project patterns
**Use when**: Working with CLI commands, command-line interfaces, or Picocli annotations
**Templates**: CommandTemplate.java, TestTemplate.java
**Examples**: Help command implementation patterns

### 2. tdd-test-creation

**Purpose**: Create tests following Test-Driven Development principles
**Use when**: Writing tests, implementing features, or following TDD workflow
**References**: Agent coordination, TDD checklist, testing patterns

### 3. yaml-config

**Purpose**: Work with YAML configuration files for pipelines, tools, and root configs
**Use when**: Creating, modifying, or validating YAML files
**Schemas**: Pipeline schema, tools schema, configuration examples

### 4. gradle-build

**Purpose**: Work with Gradle multi-module build configuration
**Use when**: Modifying build files, adding dependencies, or managing module structure
**Templates**: Build configuration templates, reference documentation

### 5. agent-workflow

**Purpose**: Coordinate development workflow using the project's agent system
**Use when**: Planning development, reviewing code, or managing TDD process
**Workflows**: Development workflows, agent coordination examples

## Skill Discovery

Skills are automatically discovered by Qwen Code and can be:

- **Model-invoked**: Automatically activated based on context and keywords
- **Explicitly invoked**: Use `/skills <skill-name>` command

## Project Integration

All skills are tailored to:

- **Technology Stack**: Java 25, Gradle 8.x, Picocli 4.7+, Jooby 4.1, SnakeYAML 2.0+
- **Architecture**: Multi-module structure (core, cli, server)
- **Workflow**: Strict TDD with agent-based development
- **Patterns**: Established conventions from existing codebase

## File Structure

```
.qwen/skills/
├── java-cli-command/
│   ├── SKILL.md
│   ├── templates/
│   └── examples/
├── tdd-test-creation/
│   ├── SKILL.md
│   ├── reference.md
│   └── checklists/
├── yaml-config/
│   ├── SKILL.md
│   ├── schemas/
│   └── examples/
├── gradle-build/
│   ├── SKILL.md
│   ├── templates/
│   └── reference.md
├── agent-workflow/
│   ├── SKILL.md
│   ├── workflows/
│   └── examples/
└── README.md
```

## Usage Examples

### Creating a CLI Command

```
User: "I need to add a cleanup command to the CLI"
→ Qwen automatically invokes java-cli-command skill
→ Provides templates and patterns from HelpCommand.java
→ Guides through TDD implementation with test creation
```

### Writing Tests

```
User: "Help me write tests for the new pipeline feature"
→ Qwen automatically invokes tdd-test-creation skill
→ Provides red-green-refactor workflow guidance
→ References existing test patterns and agent requirements
```

### YAML Configuration

```
User: "Create a pipeline configuration for document processing"
→ Qwen automatically invokes yaml-config skill
→ Provides schema guidance and examples
→ Ensures compliance with project YAML patterns
```

## Quality Assurance

All skills enforce:

- **TDD Compliance**: Red-green-refactor workflow
- **Project Patterns**: Consistent with existing codebase
- **Agent Coordination**: Proper use of planner, code-reviewer, tester
- **Documentation**: Clear instructions with file references
- **Best Practices**: Security, quality, and maintainability

## References

- `docs/tdd.md` - Technical design and TDD requirements
- `.claude/agents/` - Agent system documentation
- Existing codebase for patterns and conventions
- Project build configuration for dependency management
