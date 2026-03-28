# Technical Design Document Index: Machinum Pipeline

**Machinum Pipeline** is a pluggable document processing orchestration engine that manages stateful pipelines with tool
composition, checkpointing, and hybrid execution modes.

This document serves as an index to specialized technical documentation.

---

## Document Index

| Document                                  | Description                                                                 |
|-------------------------------------------|-----------------------------------------------------------------------------|
| [Technical Design](technical-design.md)   | Architecture, execution models, error handling, Groovy integration, roadmap |
| [YAML Schema](yaml-schema.md)             | Configuration file formats: root, tools, and pipeline manifests             |
| [Core Architecture](core-architecture.md) | Runtime architecture, state management, checkpointing, admin UI             |
| [CLI Commands](cli-commands.md)           | Command-line interface reference                                            |
| [Project Structure](project-structure.md) | Directory layout, Gradle modules, workspace organization                    |

---

## Quick Reference

### For Implementation

- Start with [YAML Schema](yaml-schema.md) to define your pipeline configuration
- Reference [CLI Commands](cli-commands.md) for execution and management
- Consult [Project Structure](project-structure.md) for workspace layout

### For Architecture Understanding

- Read [Technical Design](technical-design.md) for high-level design and decisions
- Review [Core Architecture](core-architecture.md) for runtime behavior and state management

---

**Document Version:** 1.5  
**Last Updated:** 2026-03-27  
**Status:** Approved for Phase 1 Development
