# No real COM instance or user document is used here.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\native\hwp-core.ps1')
$script:openAccepted = $false
$script:actions = @()
$script:hwp = New-Object PSObject
$script:hwp | Add-Member ScriptMethod Run { param($action) $script:actions += $action; return $script:openAccepted }
function Get-Snapshot { return @{ documentId = 'test'; path = 'C:\reports\existing.hwp'; text = 'existing content' } }
$script:baseline = @{ text = 'stale' }
$cancel = Invoke-HwpCommand ([pscustomobject]@{ command = 'open' })
if (-not $cancel.cancelled -or $null -ne $script:baseline) { throw 'Cancellation did not invalidate the previous baseline.' }
$script:openAccepted = $true
$opened = Invoke-HwpCommand ([pscustomobject]@{ command = 'open' })
if ($opened.path -ne 'C:\reports\existing.hwp' -or $script:baseline.text -ne 'existing content') { throw 'Opened file snapshot was not captured.' }
if (($script:actions -join ',') -ne 'FileOpen,FileOpen') { throw 'Unexpected native action.' }
$script:hwp | Add-Member ScriptMethod Run { param($action) throw 'Open failed' } -Force
$failed = $false
try { $null = Invoke-HwpCommand ([pscustomobject]@{ command = 'open' }) } catch { $failed = $true }
if (-not $failed -or $null -ne $script:baseline) { throw 'Open failure did not invalidate baseline.' }
'HWP_OPEN_SMOKE_OK'
