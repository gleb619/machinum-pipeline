# Instructions
**Instructions for Coding Agent: Working with ORCH**

Below are programmatic instructions for interacting with the **ORCH** (One CLI to orchestrate them all) platform. Focus
is on automation use cases: initiating a project, spawning agents, running tasks, monitoring status, and especially
using the **shell adapter** to integrate arbitrary CLI tools (e.g., custom agents).

## 1. Installation & Project Initiation

```bash
# Global installation (Node.js >= 20 required)
npm install -g @oxgeneral/orch

# Navigate to your project directory and launch ORCH (auto-initializes)
cd /path/to/your/project
orch
```

The first `orch` command creates a `.orchestry/` directory containing all state (YAML/JSON files). No database, no
cloud – everything is local file‑based.

## 2. Core Concepts

| Concept               | Description                                                                                     |
|-----------------------|-------------------------------------------------------------------------------------------------|
| **Agent**             | An executable unit (Claude, Codex, shell command).                                              |
| **Task**              | A unit of work assigned to an agent.                                                            |
| **Goal**              | A high‑level objective that the CTO agent automatically decomposes into tasks.                  |
| **Department (Team)** | A group of agents sharing a common purpose.                                                     |
| **Adapter**           | Integration layer for different agent types (`claude`, `codex`, `cursor`, `opencode`, `shell`). |

## 3. Creating Agents – Emphasis on Shell Adapter

The **shell adapter** runs any CLI tool as an agent. It spawns the command via `bash -lc` and passes the task prompt
through the environment variable `ORCHESTRY_TASK_PROMPT`.

### 3.1 Adding a Shell‑Based Agent

```bash
# Add a shell agent that wraps a custom CLI tool
orch agent add \
  --adapter shell \
  --name "my-custom-cli" \
  --command "python3 /path/to/my_agent.py" \
  --role "Run proprietary NLP tasks" \
  --cwd "/path/to/workspace"
```

* The `--command` argument is mandatory for shell adapters. It can be any executable that reads `ORCHESTRY_TASK_PROMPT`
  from its environment and produces output on stdout/stderr.
* Use `--cwd` to set the working directory for the command.
* System prompt can be added via `--system-prompt "..."`.

### 3.2 Example: Custom CLI Agent in Python

**my_agent.py**
```python
#!/usr/bin/env python3
import os
import sys

prompt = os.environ.get("ORCHESTRY_TASK_PROMPT", "")
if not prompt:
    sys.exit(1)

# … perform your logic (call LLM, run heuristic, etc.)
result = f"Processed: {prompt}"

print(result)          # stdout → captured as agent output
# stderr → captured as error
```

The adapter collects both stdout and stderr as events and considers exit code 0 as success.

### 3.3 Testing a Shell Agent

ORCH provides a built‑in test mechanism:

```bash
orch agent test my-custom-cli
```

The shell adapter’s test simply runs `bash --version` to verify a working shell environment.

## 4. Working with Tasks

### 4.1 Creating a Task

```bash
# Create a task with priority 1 (highest) – 4 (lowest)
orch task add "Perform sentiment analysis on dataset" -p 1
```

### 4.2 Assigning a Task to an Agent

```bash
# Manual assignment
orch task assign my-custom-cli --task-id <task-id>
```

Tasks can also be assigned automatically by the orchestrator based on agent availability and task priority.

## 5. Running Orchestration

### 5.1 Interactive / Watch Mode

```bash
# Run all available tasks and watch live progress
orch run --all --watch
```

### 5.2 Headless Daemon Mode (for Servers / CI/CD)

```bash
# Run orchestrator as a background daemon (structured JSON logs)
orch serve

# Run once (process all TODO tasks, then exit)
orch serve --once

# With custom log format and file
orch serve --log-format json --log-file /var/log/orch.log --verbose
```

The daemon picks up newly added tasks on each tick (default interval 10 s).

## 6. Checking Status and Logs

### 6.1 Quick Overview

```bash
orch status
```

Outputs a summary of agents, tasks, and their current states.

### 6.2 Listing Agents / Tasks

```bash
orch agent list          # Status of all agents
orch task list           # All tasks with priorities and assignment
```

### 6.3 Viewing Logs

```bash
# See logs for a specific run (run ID from `orch status` or `orch task list`)
orch logs <run-id>

# In daemon mode, logs are JSON lines to stdout; pipe to jq or aggregator:
orch serve 2>&1 | jq '.'
```

### 6.4 Programmatic Status (JSON Output)

For automation, the daemon mode outputs every event as a single JSON line:

```json
{"ts":"2026-03-17T03:00:10.000Z","level":"info","event":"agent:started","agentId":"agt_abc","taskId":"tsk_123","runId":"run_xyz"}
{"ts":"2026-03-17T03:12:45.000Z","level":"info","event":"task:status_changed","taskId":"tsk_123","from":"in_progress","to":"review"}
```

You can tail and parse these events to integrate with external monitoring.

## 7. Advanced: Deploying Pre‑built Teams

Deploy a complete department with one command:

```bash
# Engineering team for MVP
orch org deploy startup-mvp --goal "Build a REST API for user management"

# Non‑engineering examples
orch org deploy content-agency   --goal "Write 5 blog posts about AI"
orch org deploy data-lab         --goal "Analyze sales data and produce a report"
```

Pre‑built teams use a mix of Claude, Codex, and shell agents. You can export your own setup as a reusable template:

```bash
orch org export my-custom-team
```

## 8. Using Goals (CTO Agent)

The CTO agent automatically decomposes a high‑level goal into concrete tasks, assigns priorities, and routes them to the
appropriate departments.

```bash
# Add a goal
orch goal add "Refactor authentication module" --description "Replace JWT with OAuth2, add tests"

# After creating the goal, run the orchestrator to let the CTO decompose it
orch run --all --watch
```

The CTO agent (must be created with the `claude` adapter) will generate tasks and assign them to backend/frontend agents.

## 9. Communication Between Agents

Agents can exchange messages without copy‑pasting:

```bash
# Direct message to an agent
orch msg send <agent-id> "Please use the 'v2' database schema"

# Broadcast to a whole department
orch msg broadcast "API contract has changed" --team backend-team
```

A shared context store is also available:

```bash
orch context set "db_schema_version=v2"
```

## 10. Best Practices for Shell Adapters

* **Environment Variables**: The task prompt is passed as `ORCHESTRY_TASK_PROMPT`. Any custom environment variables
  required by your CLI tool must be set when adding the agent (use `--env` flag) or be present in the shell environment.
* **Exit Codes**: Your custom tool **must** return exit code `0` on success. Any non‑zero exit code is treated as a
  failure; ORCH will automatically retry according to the configured retry policy (exponential backoff).
* **Output Handling**: ORCH captures stdout and stderr as separate event streams. You can control verbosity with the
  `--log-format` and `--verbose` flags.
* **Isolation**: Each agent runs in its own Git worktree (isolated branch). This prevents file conflicts and ensures no
  code touches `main` without explicit approval.
* **Resource Usage**: Each shell agent consumes ~10–50 MB RAM. Plan accordingly for concurrent agents.

## 11. Shutting Down and Cleanup

```bash
# Graceful shutdown (SIGINT/SIGTERM) works in daemon mode:
#   stops accepting new tasks, waits for running agents, saves state
kill -INT <orch-pid>

# Disable an agent without deleting its configuration
orch agent disable my-custom-cli
```

## 12. Troubleshooting

| Problem                            | Likely Cause                       | Solution                                                                         |
|------------------------------------|------------------------------------|----------------------------------------------------------------------------------|
| Shell agent fails to start         | Missing `--command`                | Re‑add agent with proper command                                                 |
| Task stuck “in_progress”           | Agent process hanged               | Zombie detection auto‑kills after timeout; manually `orch task cancel <task-id>` |
| CTO does not decompose goals       | No CTO agent with `claude` adapter | `orch agent add --adapter claude --role "CTO" --name cto`                        |
| Daemon lock error                  | Another orchestrator running       | Stop the other process; lock file is `.orchestry/orchestry.lock`                 |
| Command not found in shell adapter | `bash` not in PATH                 | Ensure `bash` is available and reachable                                         |

## Appendix: Full CLI Reference

```bash
orch init                         # Initialize project (creates .orchestry/)
orch doctor                       # System diagnostics
orch agent add --adapter <type>   # Add agent
orch agent list                   # List all agents
orch agent disable/enable <id>    # Toggle availability
orch task add "Title" -p 1..4     # Add task with priority
orch task list                    # List tasks
orch task assign <agent-id>       # Manually assign task
orch task cancel <task-id>        # Cancel running task
orch run --all --watch            # Run all tasks and watch
orch serve                        # Headless daemon
orch serve --once                 # CI/CD: process and exit
orch status                       # Quick status overview
orch logs <run-id>                # View run logs
orch tui                          # Launch TUI (default)
orch config edit                  # Edit configuration in $EDITOR
```

For additional details, refer to the [official README](https://github.com/oxgeneral/ORCH#readme) and
the [npm package page](https://www.npmjs.com/package/@oxgeneral/orch).

---

## 13. Verified Findings (Session 2026-05-03)

Tested ORCH v1.0.22 with Qwen v0.15.2 on Node v22.20.0 (Linux).

### 13.1 Shell Adapter Deep Dive

The shell adapter spawns the command via `bash -lc` and passes the task prompt **exclusively** through the
`ORCHESTRY_TASK_PROMPT` environment variable. It does **NOT** pass the prompt as a positional argument, stdin, or
`--prompt` flag.

This means most CLI tools will **fail silently** when used directly — they ignore `ORCHESTRY_TASK_PROMPT` and either
hang waiting for stdin or exit with code 1. A **thin wrapper script** is required for every tool.

### 13.2 Thin Wrapper Pattern (Required)

Save as a `.sh` file and reference it in `orch agent add --command`:

```bash
#!/bin/bash
# Wrapper for ORCH shell adapter — reads $ORCHESTRY_TASK_PROMPT, passes to tool
set -e

PROMPT="${ORCHESTRY_TASK_PROMPT:-}"
if [ -z "$PROMPT" ]; then
    echo "ERROR: ORCHESTRY_TASK_PROMPT not set" >&2
    exit 1
fi

# For tools accepting positional args:
exec <tool> "$PROMPT"

# For tools accepting stdin:
# echo "$PROMPT" | <tool>

# For tools with --prompt flag:
# exec <tool> --prompt "$PROMPT"
```

**Verified pattern for Qwen**:
```bash
#!/bin/bash
PROMPT="${ORCHESTRY_TASK_PROMPT:-}"
[ -z "$PROMPT" ] && exit 1
exec qwen -y "$PROMPT"
```

Tested and confirmed working: task completed in 6 seconds, output matched expected text.

### 13.3 Execution Mode: `serve --once` (NOT `run`)

The `orch run <task-id>` command **claims** the task but does NOT execute it. Actual execution
happens through the daemon scheduler. For a single execution that processes all tasks and exits:

```bash
orch serve --once
```

Produces structured JSON logs on stdout, one event per line:

```json
{"ts":"...","level":"info","event":"serve:started","mode":"once","pid":...}
{"ts":"...","level":"info","event":"task:status_changed","taskId":"tsk_...","from":"todo","to":"in_progress"}
{"ts":"...","level":"info","event":"agent:started","agentId":"agt_...","taskId":"tsk_...","runId":"run_..."}
{"ts":"...","level":"info","event":"agent:completed","runId":"run_...","agentId":"agt_...","success":true}
{"ts":"...","level":"info","event":"workspace:merge_succeeded","taskId":"tsk_...","branch":"orchestry/..."}
{"ts":"...","level":"info","event":"task:status_changed","taskId":"tsk_...","from":"in_progress","to":"review"}
{"ts":"...","level":"info","event":"task:status_changed","taskId":"tsk_...","from":"review","to":"done"}
{"ts":"...","level":"info","event":"serve:finished","result":"all_done","exit_code":0}
```

### 13.4 Task Lifecycle (Verified)

```
todo → in_progress → review → done
```

Each transition emits a `task:status_changed` JSON event. The full lifecycle completed in ~6 seconds for a simple
echo task. Tasks with priority 1 are picked up immediately. The `review` status is a gating step — after agent
output is received, the orchestrator evaluates exit code and output before transitioning to `done`.

### 13.5 Git Worktree Isolation (Verified)

ORCH automatically creates a git worktree per task on branch `orchestry/tsk_<id>/<slug>`. After the agent
completes successfully, it merges the worktree branch back and emits `workspace:merge_succeeded`. The worktree
directory is cleaned up after merge.

Workspace mode is configurable per agent via `--workspace-mode`: `worktree` (default, git isolation),
`shared` (no isolation), or `isolated` (clone-based).

### 13.6 Viewing Agent Output

```bash
orch logs --task tsk_<id>
# or by run ID:
orch logs run_<id>
```

Output shows each run attempt with the agent's captured stdout. Example:
```
Run run_WGN2nk3 · attempt 1 · succeeded
  10:22:41  ▸ ORCH_SHELL_WORKS_OK
```

### 13.7 Agent Status States

Agents can be: `idle`, `running`. After a task the agent returns to `idle`. Stats track `tasks_completed`,
`tasks_failed`, `total_runs`, `total_runtime_ms`.

## 14. Updated Pitfalls (Verified)

| Problem                                                                   | Likely Cause                                               | Solution                                                                                  |
|---------------------------------------------------------------------------|------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| Shell agent fails silently, task stuck "claimed" (0 attempts)             | Tool ignores `ORCHESTRY_TASK_PROMPT`, exits with code 1    | Use a wrapper script that reads env var and passes to tool                                |
| `orch run <task-id>` exits instantly, task not executed                   | `run` only claims tasks, daemon executes them              | Use `orch serve --once` for headless execution                                            |
| Daemon lock error (`orchestry.lock`)                                      | Previous run did not exit cleanly                          | `rm .orchestry/orchestry.lock`                                                            |
| Agent output not visible                                                  | Logs are per-run, not per-task by default                  | `orch logs --task <task-id>`                                                              |
| Task stuck in "claimed" with 0 attempts, never transitions to in_progress | Agent failed before starting (bad command, missing binary) | Check agent config, test command manually with `ORCHESTRY_TASK_PROMPT=<prompt> <command>` |
| Workspace not cleaned up after completion                                 | Merge succeeded but worktree directory remains             | ORCH auto-cleans after successful merge; leftover is a `.git` stub                        |
| Wrapper script fails with "Permission denied"                             | Script not executable                                      | `chmod +x wrapper.sh` before `orch agent add`                                             |