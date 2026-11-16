#!/usr/bin/env bash
# One-time setup on macOS / Linux:   bash setup.sh
# Creates the Python virtual environment in .venv, installs the two test libraries, runs the tests.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "Python 3.10 or newer is required")'
"$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet pytest hypothesis
.venv/bin/python -m pytest -q
echo
echo "Setup complete. Next:"
echo "  .venv/bin/python examples/run_e2e.py               # end-to-end example"
echo "  .venv/bin/python -m limen.service --port 8088      # start the HTTP service"
