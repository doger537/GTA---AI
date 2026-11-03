@echo off
cd /d "%~dp0"
node record-observations.mjs --seconds=120 --role=development --camera=rear
pause
