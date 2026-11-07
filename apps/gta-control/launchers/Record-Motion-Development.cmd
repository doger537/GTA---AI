@echo off
cd /d "%~dp0../../../"
node apps/gta-control/cli/record-observations.mjs --seconds=120 --role=development --camera=rear
pause
