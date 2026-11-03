@echo off
cd /d "%~dp0"
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" train-controls.mjs datasets/2026-11-01T17-32-01-342Z datasets/2026-11-01T16-49-20-088Z --epochs=2
pause
