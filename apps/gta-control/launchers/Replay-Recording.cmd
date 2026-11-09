@echo off
chcp 65001 >nul
cd /d "%~dp0../../../"
rem Offline replay only: reads a saved observation recording. No bridge, no input.
if "%~1"=="" (
  echo Использование: Replay-Recording.cmd ^<папка-записи^> [--skill] [--frames=40]
  echo Пример: experiments\observation-recordings\2026-11-09T...
  pause
  exit /b 2
)
node experiments/tools/replay-observations.mjs "%~1" %2 %3 %4 --out="%~1\replay-report.json"
if errorlevel 1 goto failed
echo.
echo Готово: %~1\replay-report.json
echo Картинки выбранного пути: %~1\paths
goto done
:failed
echo Replay прерван из-за ошибки. Смотри сообщение выше.
:done
pause
