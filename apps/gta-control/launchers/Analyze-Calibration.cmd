@echo off
chcp 65001 >nul
cd /d "%~dp0../../../"
rem Offline only: reads saved calibration report.json files. No game, no input.
if "%~1"=="" (
  echo Использование: Analyze-Calibration.cmd ^<папка-runs-calibration^> [--vehicle=NAME]
  echo Пример: experiments\runs\calibration
  pause
  exit /b 2
)
node experiments/tools/analyze-calibration.mjs "%~1" %2 %3
if errorlevel 1 goto failed
echo.
echo Готово: %~1\calibration-review.json
echo Черновик коэффициентов не является проверенным bundle и gate его не примет.
goto done
:failed
echo Анализ прерван из-за ошибки. Смотри сообщение выше.
:done
pause
