$ErrorActionPreference = 'Stop'
$exe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\bin\HWP-Copilot-0.3.1-x64.exe'))
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Build the portable EXE first.' }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$started = [DateTime]::UtcNow
$process = Start-Process -FilePath $exe -ArgumentList '--smoke-test' -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw ('Packaged app returned exit code ' + $process.ExitCode) }
$reportPath = Join-Path ([IO.Path]::GetTempPath()) 'HWP-Copilot-smoke\desktop-smoke.json'
$reportFile = Get-Item -LiteralPath $reportPath
if ($reportFile.LastWriteTimeUtc -lt $started.AddSeconds(-2)) { throw 'Packaged smoke report is stale.' }
$report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $report.desktop -or -not $report.isolated -or -not $report.profileSaved -or $report.errors.Count -ne 0) { throw 'Packaged smoke report failed validation.' }
'PACKAGED_SMOKE_OK'
$report | ConvertTo-Json -Depth 4
