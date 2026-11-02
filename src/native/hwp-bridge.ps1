$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'hwp-core.ps1')
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
        $request = $line | ConvertFrom-Json
        $data = Invoke-HwpCommand $request
        $response = @{ id = $request.id; ok = $true; data = $data }
    } catch {
        $response = @{ id = $request.id; ok = $false; error = $_.Exception.Message }
    }
    [Console]::WriteLine(($response | ConvertTo-Json -Depth 12 -Compress))
}
# Never send Quit or Clear to HWP when the helper is stopped.
