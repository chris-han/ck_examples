#!/usr/bin/env bash
set -euo pipefail

# Bootstraps uv and creates the project's .venv, then syncs dependencies.
# Usage: ./scripts/setup_venv.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# We'll create the virtual environment under the agent/ directory so it's only used for agent code
AGENT_DIR="$ROOT_DIR/agent"
cd "$AGENT_DIR"

echo "Checking for uv..."
if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found. Attempting to install via pip..."
  if command -v pip >/dev/null 2>&1; then
    pip install --user uv
  else
    echo "pip not found. Please install pip or uv manually."
    exit 1
  fi
fi

echo "Creating virtual environment with uv in agent/.venv..."
uv venv

echo "Activating agent/.venv and synchronizing dependencies (if lock/requirements present in agent/)..."
if [ -f "pyproject.toml" ] || [ -f "requirements.txt" ] || [ -f "requirements.in" ]; then
  # Prefer uv lock/sync flow if a lockfile is present
  if [ -f "uv.lock" ]; then
    uv pip sync uv.lock
  elif [ -f "requirements.txt" ]; then
    uv pip sync requirements.txt
  else
    echo "No lockfile detected. You can add dependencies with 'uv add <pkg>' or create a lock with 'uv lock'."
  fi
else
  echo "No dependency files found; .venv has been created. Activate with: source .venv/bin/activate"
fi

echo "Done. If you're in VS Code, reopen the workspace or open a new terminal to see auto-activation." 
