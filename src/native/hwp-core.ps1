$ErrorActionPreference = 'Stop'
$script:hwp = $null
$script:baseline = $null
$script:connectedProgId = $null

function Get-HwpRegistrations {
    $items = @()
    foreach ($entry in Get-ChildItem 'Registry::HKEY_CLASSES_ROOT' -ErrorAction SilentlyContinue) {
        if ($entry.PSChildName -notmatch '^HWPFrame\.HwpObject(\.\d+)?$') { continue }
        $progId = $entry.PSChildName
        $clsidKey = Get-Item -LiteralPath ($entry.PSPath + '\CLSID') -ErrorAction SilentlyContinue
        if ($null -eq $clsidKey) { continue }
        $clsid = $clsidKey.GetValue('')
        $serverKey = Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\CLSID\' + $clsid + '\LocalServer32') -ErrorAction SilentlyContinue
        $server = if ($null -ne $serverKey) { [string]$serverKey.GetValue('') } else { '' }
        # Out-of-process 32-bit HWP can be activated from 64-bit PowerShell,
        # while its CLSID server path exists only in the 32-bit registry view.
        if (-not $server) {
            $registry32 = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, [Microsoft.Win32.RegistryView]::Registry32)
            try {
                $server32 = $registry32.OpenSubKey('CLSID\' + $clsid + '\LocalServer32')
                if ($null -ne $server32) { try { $server = [string]$server32.GetValue('') } finally { $server32.Dispose() } }
            } finally { $registry32.Dispose() }
        }
        $version = ''
        $exe = ''
        if ($server -match '^"([^"]+)"') { $exe = $Matches[1] }
        elseif ($server -match '^(.+?\.exe)') { $exe = $Matches[1] }
        if ($exe -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
            $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
        }
        $items += @{ progId = $progId; version = $version; executable = $exe }
    }
    return @($items | Sort-Object { $_.progId })
}

function Get-HwpWindow {
    $window = $script:hwp.XHwpWindows.Active_XHwpWindow
    $handle = [long]$window.WindowHandle
    if ($handle -lt 0) { $handle += 4294967296L }
    if ($handle -eq 0) { throw 'HWP_WINDOW_UNAVAILABLE' }
    $version = ''
    try { $version = [string]$script:hwp.Version } catch { }
    return @{ hwnd = [string]$handle; version = $version; progId = $script:connectedProgId }
}

function Get-Snapshot {
    $window = Get-HwpWindow
    $doc = $script:hwp.XHwpDocuments.Active_XHwpDocument
    $list = 0; $para = 0; $pos = 0
    $null = $script:hwp.GetPos([ref]$list, [ref]$para, [ref]$pos)
    $sl = 0; $sp = 0; $sc = 0; $el = 0; $ep = 0; $ec = 0
    $null = $script:hwp.GetSelectedPos([ref]$sl, [ref]$sp, [ref]$sc, [ref]$el, [ref]$ep, [ref]$ec)
    return @{
        documentId = [string]$doc.DocumentID
        path = [string]$doc.FullName
        text = [string]$script:hwp.GetTextFile('UNICODE', '')
        selection = [string]$script:hwp.GetTextFile('UNICODE', 'saveblock')
        position = @($list, $para, $pos, $sl, $sp, $sc, $el, $ep, $ec)
        hwnd = $window.hwnd
        version = $window.version
        progId = $window.progId
    }
}

function Assert-Unchanged {
    if ($null -eq $script:baseline) { throw 'Read the document again before applying changes.' }
    $now = Get-Snapshot
    foreach ($key in @('documentId', 'hwnd', 'path', 'text', 'selection')) {
        if ($now[$key] -cne $script:baseline[$key]) { throw 'Document or selection changed. Read it again and regenerate the draft.' }
    }
    if (($now.position -join ',') -ne ($script:baseline.position -join ',')) {
        throw 'Cursor or selected range moved. Read the document again.'
    }
}

function Invoke-HwpCommand($request) {
        if ($request.command -eq 'diagnostics') {
            return @{ platform = 'win32'; registrations = @(Get-HwpRegistrations); powershell = $PSVersionTable.PSVersion.ToString(); architecture = if ([Environment]::Is64BitProcess) { 'x64' } else { 'x86' } }
        }
        if ($request.command -eq 'connect') {
            $progId = if ($request.progId) { [string]$request.progId } else { 'HWPFrame.HwpObject' }
            if ($progId -notmatch '^HWPFrame\.HwpObject(\.\d+)?$') { throw 'INVALID_HWP_PROGID' }
            if ($null -ne $script:hwp) {
                try { $null = Get-HwpWindow } catch { $script:hwp = $null; $script:baseline = $null }
            }
            if ($null -eq $script:hwp) {
                # Own a separate instance; never guess which existing user document to edit.
                try { $script:hwp = New-Object -ComObject $progId } catch { throw 'HWP_COM_UNAVAILABLE' }
                $script:connectedProgId = $progId
                $script:hwp.XHwpWindows.Active_XHwpWindow.Visible = $true
            } elseif ($progId -ne $script:connectedProgId) {
                throw 'HWP_ALREADY_CONNECTED'
            }
            $data = Get-HwpWindow
            $data.connected = $true
            # Fail closed if the installed version cannot provide a safe editing snapshot.
            try { $null = Get-Snapshot; $data.editingSupported = $true }
            catch { $data.editingSupported = $false; $data.compatibilityError = 'HWP_REQUIRED_API_UNAVAILABLE' }
        } else {
            if ($null -eq $script:hwp) { throw 'Connect to HWP first.' }
            switch ($request.command) {
                'open' {
                    # Use HWP's own picker and unsaved-change prompts on every supported version.
                    # Invalidate even on cancellation; the user may have interacted with the document.
                    $script:baseline = $null
                    if (-not $script:hwp.Run('FileOpen')) {
                        $data = @{ cancelled = $true }
                    } else {
                        $script:baseline = Get-Snapshot
                        $data = $script:baseline
                    }
                }
                'read' {
                    $script:baseline = Get-Snapshot
                    $data = $script:baseline
                }
                'apply' {
                    if ([string]::IsNullOrWhiteSpace($request.text)) { throw 'Text is empty.' }
                    Assert-Unchanged
                    if ($request.mode -eq 'replace') {
                        if ([string]::IsNullOrWhiteSpace($script:baseline.selection)) { throw 'Select text in HWP first.' }
                    } elseif ($request.mode -eq 'insert') {
                        if (-not [string]::IsNullOrEmpty($script:baseline.selection)) { throw 'Clear the selection in HWP before inserting.' }
                    } else { throw 'Unknown edit mode.' }
                    $action = $script:hwp.CreateAction('InsertText')
                    $set = $action.CreateSet()
                    $null = $action.GetDefault($set)
                    $null = $set.SetItem('Text', ([string]$request.text).Replace("`r`n", "`n").Replace("`n", "`r`n"))
                    # Consume the baseline before mutation to prevent repeated application.
                    $script:baseline = $null
                    if (-not $action.Execute($set)) { throw 'HWP refused the edit. Check whether the document is read-only.' }
                    $data = @{ applied = $true }
                }
                'save' {
                    # HWP displays its own Save As dialog for a new document.
                    if (-not $script:hwp.Run('FileSave')) { throw 'Save was cancelled or failed.' }
                    $script:baseline = $null
                    $data = @{ saved = $true }
                }
                default { throw 'Unknown command.' }
            }
        }
        return $data
}
