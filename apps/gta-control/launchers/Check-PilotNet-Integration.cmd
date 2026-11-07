@echo off
chcp 65001 >nul
cd /d "%~dp0../../../"
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
echo Проверка модели и аналогового адаптера на имитаторе. GTA не управляется.
"%NODE_EXE%" apps/gta-control/cli/analog-smoke.mjs
if errorlevel 1 goto failed
"%NODE_EXE%" apps/gta-control/cli/pilotnet-analog-preview.mjs
if errorlevel 1 goto failed
echo Проверка завершена. Результаты в runs\analog.
goto done
:failed
echo Проверка прервана из-за ошибки. Смотри сообщение выше.
:done
pause
