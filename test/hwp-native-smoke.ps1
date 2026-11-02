# Creates its own blank automation document. Never attaches to an existing object.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\native\hwp-core.ps1')
$originalDocumentId = $null
$first = 'HWP Copilot smoke insert'
$second = 'HWP Copilot smoke replace ' + [char]0xD55C + [char]0xAE00
try {
    $connection = Invoke-HwpCommand ([pscustomobject]@{ command = 'connect'; progId = 'HWPFrame.HwpObject' })
    if ($script:hwp.XHwpDocuments.Count -ne 1) { throw 'Expected one fresh automation document; stopping before editing.' }
    $initial = Invoke-HwpCommand ([pscustomobject]@{ command = 'read' })
    if ($initial.path -or $initial.text.Trim()) { throw 'Expected an empty unsaved document; stopping before editing.' }
    $originalDocumentId = $initial.documentId
    $null = Invoke-HwpCommand ([pscustomobject]@{ command = 'apply'; mode = 'insert'; text = $first })
    $afterInsert = Invoke-HwpCommand ([pscustomobject]@{ command = 'read' })
    if ($afterInsert.text.Trim() -cne $first) { throw 'Insert verification failed.' }
    $null = $script:hwp.Run('MoveDocBegin')
    $blocked = $false
    try { $null = Invoke-HwpCommand ([pscustomobject]@{ command = 'apply'; mode = 'insert'; text = 'SHOULD NOT INSERT' }) }
    catch { $blocked = $true }
    if (-not $blocked) { throw 'Cursor-change guard failed.' }
    $null = $script:hwp.Run('SelectAll')
    $selection = Invoke-HwpCommand ([pscustomobject]@{ command = 'read' })
    if ($selection.selection.Trim() -cne $first) { throw 'Selection read verification failed.' }
    $null = Invoke-HwpCommand ([pscustomobject]@{ command = 'apply'; mode = 'replace'; text = $second })
    $afterReplace = Invoke-HwpCommand ([pscustomobject]@{ command = 'read' })
    if ($afterReplace.text.Trim() -cne $second) { throw ('Selection replacement verification failed: ' + (@{ expected = $second; actual = $afterReplace.text; selection = $afterReplace.selection; position = $afterReplace.position } | ConvertTo-Json -Compress)) }
    $null = $script:hwp.Run('Undo')
    $afterUndo = Invoke-HwpCommand ([pscustomobject]@{ command = 'read' })
    if ($afterUndo.text.Trim() -cne $first) { throw 'Undo verification failed.' }
    @{ result = 'HWP_NATIVE_SMOKE_OK'; version = $connection.version; hwnd = $connection.hwnd; checks = @('read', 'insert', 'cursor guard', 'selection', 'replace with Korean text', 'undo') } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $script:hwp -and $null -ne $originalDocumentId) {
        # Only discard the exact known test text in the single document created above.
        $doc = $script:hwp.XHwpDocuments.Active_XHwpDocument
        $text = ([string]$script:hwp.GetTextFile('UNICODE', '')).Trim()
        if ($script:hwp.XHwpDocuments.Count -eq 1 -and [string]$doc.DocumentID -eq $originalDocumentId -and -not $doc.FullName -and $text -cin @('', $first, $second, ($first + $second), ($second + $first))) {
            $null = $script:hwp.Clear(1)
            $null = $script:hwp.Quit()
        }
    }
}
