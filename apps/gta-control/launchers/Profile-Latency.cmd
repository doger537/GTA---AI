@echo off
cd /d "%~dp0../../../"
echo Read-only profiling. Leave GTA active; no driving commands will be sent.
if "%~1"=="" (
  echo Usage: Profile-Latency.cmd PATH_TO_CAPTURE_DIRECTORY
  echo Create capture directory first: node experiments/tools/profile-capture.mjs --frames=24
  pause
  exit /b 1
)
node experiments/tools/profile-pipeline.mjs "%~1" --live --frames=16
pause
