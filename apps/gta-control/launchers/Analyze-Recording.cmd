@echo off
chcp 65001 >nul
cd /d "%~dp0../../../"
rem Offline only: reads an existing observation recording. No game input, no bridge.
if "%~1"=="" (
  echo Использование: Analyze-Recording.cmd ^<папка-записи^> [--ocr]
  echo Пример: experiments\observation-recordings\2026-11-09T...
  pause
  exit /b 2
)
node experiments/tools/analyze-stop-observations.mjs "%~1" %2 --out="%~1\stop-analysis.json"
if errorlevel 1 goto failed
echo.
echo Готово: %~1\stop-analysis.json
goto done
:failed
echo Анализ прерван из-за ошибки. Смотри сообщение выше.
:done
pause
