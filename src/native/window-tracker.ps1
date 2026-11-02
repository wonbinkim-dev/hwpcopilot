param([Parameter(Mandatory=$true)][long]$TargetHandle)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using System.Threading;
public static class DockNative {
    static readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
    public static volatile bool InputClosed;
    public static void StartInputReader() {
        var reader = new Thread(() => { try { string line; while ((line = Console.ReadLine()) != null) commands.Enqueue(line); } finally { InputClosed = true; } });
        reader.IsBackground = true; reader.Start();
    }
    public static string ReadCommand() { string line; return commands.TryDequeue(out line) ? line : null; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] public struct PLACEMENT {
        public int length, flags, showCmd; public POINT min, max; public RECT normal;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int size; public RECT monitor, work; public uint flags; }
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref PLACEMENT p);
    [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref PLACEMENT p);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
try { $null = [DockNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
$target = [IntPtr]$TargetHandle
$targetProcess = [uint32]0
$null = [DockNative]::GetWindowThreadProcessId($target, [ref]$targetProcess)
$original = New-Object DockNative+PLACEMENT
$original.length = [Runtime.InteropServices.Marshal]::SizeOf($original)
$haveOriginal = [DockNative]::GetWindowPlacement($target, [ref]$original)
$arranged = $false
[DockNative]::StartInputReader()
try {
    while ($true) {
        $currentProcess = [uint32]0
        $null = [DockNative]::GetWindowThreadProcessId($target, [ref]$currentProcess)
        $exists = [DockNative]::IsWindow($target) -and ($currentProcess -eq $targetProcess)
        if (-not $exists) { [Console]::WriteLine('{"exists":false}'); break }
        $line = [DockNative]::ReadCommand()
        if ($null -ne $line) {
            $command = $line | ConvertFrom-Json
            if ($command.command -eq 'stop') { break }
            if ($command.command -eq 'layout') {
                $monitor = New-Object DockNative+MONITORINFO
                $monitor.size = [Runtime.InteropServices.Marshal]::SizeOf($monitor)
                $null = [DockNative]::GetMonitorInfo([DockNative]::MonitorFromWindow($target, 2), [ref]$monitor)
                $reserve = [Math]::Max(320, [Math]::Min(900, [int]$command.width)) + 6
                $width = $monitor.work.right - $monitor.work.left - $reserve
                if ($width -ge 560) {
                    $null = [DockNative]::ShowWindow($target, 9)
                    $null = [DockNative]::SetWindowPos($target, [IntPtr]::Zero, $monitor.work.left, $monitor.work.top, $width, ($monitor.work.bottom - $monitor.work.top), 0x0014)
                    $arranged = $true
                }
            }
            if ($command.command -eq 'focus') {
                if ([DockNative]::IsIconic($target)) { $null = [DockNative]::ShowWindow($target, 9) }
                $null = [DockNative]::SetForegroundWindow($target)
            }
        } elseif ([DockNative]::InputClosed) { break }
        $rect = New-Object DockNative+RECT
        $null = [DockNative]::GetWindowRect($target, [ref]$rect)
        $foregroundProcess = [uint32]0
        $null = [DockNative]::GetWindowThreadProcessId([DockNative]::GetForegroundWindow(), [ref]$foregroundProcess)
        $frame = @{ exists = $true; visible = [DockNative]::IsWindowVisible($target); minimized = [DockNative]::IsIconic($target); foreground = ($foregroundProcess -eq $targetProcess); rect = @{ x = $rect.left; y = $rect.top; width = $rect.right - $rect.left; height = $rect.bottom - $rect.top } }
        [Console]::WriteLine(($frame | ConvertTo-Json -Compress -Depth 4))
        Start-Sleep -Milliseconds 180
    }
} catch {
    [Console]::WriteLine('{"trackerError":true}')
} finally {
    $finalProcess = [uint32]0
    $null = [DockNative]::GetWindowThreadProcessId($target, [ref]$finalProcess)
    if ($arranged -and $haveOriginal -and [DockNative]::IsWindow($target) -and ($finalProcess -eq $targetProcess)) {
        $null = [DockNative]::SetWindowPlacement($target, [ref]$original)
    }
}
