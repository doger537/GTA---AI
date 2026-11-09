@echo off
chcp 65001 >nul
cd /d "%~dp0../../../"
rem Offline only: creates an empty label file. Nothing is pre-filled.
if "%~1"=="" (
  echo Использование: Make-Label-Template.cmd ^<папка-записи^> [--frames=40]
  echo Пример: experiments\observation-recordings\2026-11-09T...
  pause
  exit /b 2
)
node experiments/tools/make-label-template.mjs "%~1" %2 %3
if errorlevel 1 goto failed
echo.
echo Готово: разметка в папке записи (labels.json).
echo Открой её в редакторе и впиши точки вручную: kind у hazard-точек, road у свободных.
goto done
:failed
echo Шаблон не создан. Смотри сообщение выше.
:done
pause
