param([string]$OutputPath = (Join-Path $PSScriptRoot 'GtaControl.exe'))
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'GtaControl.cs'
$exe = [System.IO.Path]::GetFullPath($OutputPath)
Add-Type -Path $source -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -OutputAssembly $exe -OutputType WindowsApplication
Write-Host "Built: $exe"
