$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'GtaControl.cs'
$exe = Join-Path $PSScriptRoot 'GtaControl.exe'
Add-Type -Path $source -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -OutputAssembly $exe -OutputType WindowsApplication
Write-Host "Built: $exe"
