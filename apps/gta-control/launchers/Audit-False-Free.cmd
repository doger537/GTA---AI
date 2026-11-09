@echo off
chcp 65001 >nul
cd /d "%~dp0../../../"
rem Offline only: audit of labelled frames. No game, no input.
if "%~1"=="" (
  echo Использование: Audit-False-Free.cmd ^<labels.json^> [--root=папка-записи] [--intent=lane_follow] [--camera=rear]
  pause
  exit /b 2
)
node experiments/tools/audit-false-free.mjs "%~1" --root="%~dp1." %2 %3 %4 %5
if errorlevel 1 goto failed
echo.
echo Готово: рядом с labels.json лежит false-free-report.json
echo Это development-аудит на размеченных кадрах, не результат вождения.
goto done
:failed
echo Аудит прерван из-за ошибки. Смотри сообщение выше.
:done
pause
