param([string]$OutputPath = (Join-Path $PSScriptRoot '../../apps/gta-control/GtaControl.exe'))
# Compatibility entry point. The canonical build is in apps/gta-control.
& (Join-Path $PSScriptRoot '../../apps/gta-control/Build.ps1') -OutputPath $OutputPath
if (!$?) { throw 'Canonical bridge build failed' }
