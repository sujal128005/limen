@echo off
rem One-time setup on Windows:   setup.bat
rem Creates the Python virtual environment in .venv, installs the two test libraries, runs the tests.
cd /d "%~dp0"
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 'Python 3.10 or newer is required')" || exit /b 1
python -m venv .venv || exit /b 1
.venv\Scripts\python -m pip install --quiet --upgrade pip
.venv\Scripts\python -m pip install --quiet pytest hypothesis || exit /b 1
.venv\Scripts\python -m pytest -q || exit /b 1
echo.
echo Setup complete. Next:
echo   .venv\Scripts\python examples\run_e2e.py
echo   .venv\Scripts\python -m limen.service --port 8088
