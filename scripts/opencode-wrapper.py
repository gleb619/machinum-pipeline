#!/usr/bin/env python3
"""
Generic adapter wrapper for Bernstein → OpenCode CLI.
Receives --prompt and --model, shells out to opencode, returns stdout.
"""

import argparse
import subprocess
import sys
import os

OPECODE_BIN = "/home/boris/.nvm/versions/node/v22.20.0/bin/opencode"
NVM_DIR = "/home/boris/.nvm"
DEFAULT_MODEL = "opencode/big-pickle/opencode/gpt-5-nano"


def main():
    parser = argparse.ArgumentParser(description="OpenCode wrapper for Bernstein generic adapter")
    parser.add_argument("--prompt", required=True, help="Prompt to send to OpenCode")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model name (ignored, opencode uses its own config)")
    parser.add_argument("--verbose", action="store_true", help="Verbose output")
    args = parser.parse_args()

    # Source nvm and run opencode
    env = os.environ.copy()
    env["NVM_DIR"] = NVM_DIR

    cmd = (
        f'source "{NVM_DIR}/nvm.sh" && '
        f'nvm use v22.20.0 > /dev/null 2>&1 && '
        f'echo {_shell_quote(args.prompt)} | "{OPECODE_BIN}" -p "" --yolo'
    )

    if args.verbose:
        print(f"[opencode-wrapper] Running: {cmd}", file=sys.stderr)

    result = subprocess.run(
        ["bash", "-c", cmd],
        capture_output=True,
        text=True,
        env=env,
        timeout=600,
    )

    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    sys.exit(result.returncode)


def _shell_quote(s: str) -> str:
    """Simple shell quoting for piping."""
    import shlex
    return shlex.quote(s)


if __name__ == "__main__":
    main()
