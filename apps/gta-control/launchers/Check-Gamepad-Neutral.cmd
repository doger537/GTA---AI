@echo off
chcp 65001 >nul
cd /d "%~dp0../../../"
echo Проверка настоящего драйвера. Газ и тормоз не нажимаются.
"training\training-env\Scripts\python.exe" packages/actuation/check-gamepad-neutral.py %*
if errorlevel 1 echo Проверка не пройдена. Смотри ошибку выше.
pause
