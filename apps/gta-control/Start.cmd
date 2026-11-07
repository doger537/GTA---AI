@echo off
cd /d "%~dp0"
if not exist GtaControl.exe powershell.exe -NoProfile -Command "Add-Type -Path '.\GtaControl.cs' -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -OutputAssembly '.\GtaControl.exe' -OutputType WindowsApplication"
if exist GtaControl.exe start "" "%~dp0GtaControl.exe"
