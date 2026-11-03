@echo off
cd /d "%~dp0"
node record-observations.mjs --seconds=120 --role=validation --camera=rear
pause
