param(
    [string]$BaseUrl = 'http://127.0.0.1:5000',
    [string]$Hotkey = 'Ctrl+Alt+P',
    [int]$PollMs = 40,
    [switch]$Once,
    [switch]$PostOnce
)

# os-pick.ps1 - read the UI Automation element under the mouse pointer and POST it
# to the DSH host half. Pure ASCII on purpose: Windows PowerShell 5.1 reads a
# BOM-less file as ANSI, so any non-ASCII literal would be mangled.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OsPickWin32 {
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@

function Get-ShortName([string]$programmatic) {
    if ([string]::IsNullOrEmpty($programmatic)) { return '' }
    return ($programmatic -replace '^ControlType\.', '')
}

function Read-Value([System.Windows.Automation.AutomationElement]$element) {
    try {
        $pattern = $null
        $ok = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
        if ($ok -and $null -ne $pattern) { return [string]$pattern.Current.Value }
    } catch { }
    return ''
}

function Get-Pick([int]$x, [int]$y) {
    $point = New-Object System.Windows.Point($x, $y)
    $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    if ($null -eq $element) { return $null }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $chain = New-Object System.Collections.ArrayList
    $current = $element
    $top = $element
    for ($i = 0; $i -lt 8 -and $null -ne $current; $i++) {
        $top = $current
        [void]$chain.Add(@{
            name = [string]$current.Current.Name
            controlType = Get-ShortName $current.Current.ControlType.ProgrammaticName
            automationId = [string]$current.Current.AutomationId
        })
        $parent = $walker.GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent
    }

    $bounds = $element.Current.BoundingRectangle
    $topBounds = $top.Current.BoundingRectangle
    # Chromium/Electron windows expose only a generic pane until accessibility is
    # switched on, so a pick that covers the whole window is reported as the window.
    $windowOnly = $true
    if ($bounds.Width -gt 0 -and $topBounds.Width -gt 0) {
        $windowOnly = (([math]::Abs($bounds.X - $topBounds.X) -lt 8) -and
                       ([math]::Abs($bounds.Y - $topBounds.Y) -lt 8) -and
                       ([math]::Abs($bounds.Width - $topBounds.Width) -lt 8) -and
                       ([math]::Abs($bounds.Height - $topBounds.Height) -lt 8))
    }
    $processId = $element.Current.ProcessId
    $processName = ''
    $windowTitle = ''
    try {
        $process = Get-Process -Id $processId -ErrorAction Stop
        $processName = $process.ProcessName
        $windowTitle = [string]$process.MainWindowTitle
    } catch { }

    $text = Read-Value $element
    if ([string]::IsNullOrEmpty($text)) { $text = [string]$element.Current.Name }

    return @{
        name = [string]$element.Current.Name
        controlType = Get-ShortName $element.Current.ControlType.ProgrammaticName
        automationId = [string]$element.Current.AutomationId
        className = [string]$element.Current.ClassName
        text = $text
        enabled = [bool]$element.Current.IsEnabled
        processId = $processId
        processName = $processName
        windowTitle = $windowTitle
        windowOnly = $windowOnly
        cursor = @{ x = $x; y = $y }
        bounds = @{
            x = [int]$bounds.X
            y = [int]$bounds.Y
            w = [int]$bounds.Width
            h = [int]$bounds.Height
        }
        chain = @($chain)
    }
}

function Send-Pick($pick) {
    $json = $pick | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $uri = ($BaseUrl.TrimEnd('/')) + '/element-picker/os/pick'
    Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 5 | Out-Null
}

function Get-CursorPoint {
    $point = New-Object OsPickWin32+POINT
    if (-not [OsPickWin32]::GetCursorPos([ref]$point)) { return $null }
    return @{ x = $point.X; y = $point.Y }
}

# Hotkey: "Ctrl+Alt+P" -> modifier flags plus a virtual-key code.
$wantCtrl = $Hotkey -match '(?i)ctrl'
$wantAlt = $Hotkey -match '(?i)alt'
$wantShift = $Hotkey -match '(?i)shift'
$wantWin = $Hotkey -match '(?i)win'
$keyToken = ($Hotkey -split '\+')[-1].Trim().ToUpperInvariant()
$vk = 0
if ($keyToken.Length -eq 1) { $vk = [int][char]$keyToken }
elseif ($keyToken -match '^F(\d{1,2})$') { $vk = 0x6F + [int]$Matches[1] }
else { throw "Unsupported hotkey key: $keyToken" }

$VK_CONTROL = 0x11
$VK_MENU = 0x12
$VK_SHIFT = 0x10
$VK_LWIN = 0x5B

function Test-Down([int]$vkey) {
    return (([OsPickWin32]::GetAsyncKeyState($vkey) -band 0x8000) -ne 0)
}

if ($Once) {
    $cursor = Get-CursorPoint
    if ($null -eq $cursor) { Write-Output '{"error":"no cursor"}'; exit 1 }
    $pick = Get-Pick $cursor.x $cursor.y
    if ($null -eq $pick) { Write-Output '{"error":"no element"}'; exit 1 }
    Write-Output ($pick | ConvertTo-Json -Depth 6 -Compress)
    exit 0
}

if ($PostOnce) {
    $cursor = Get-CursorPoint
    if ($null -eq $cursor) { Write-Output '{"error":"no cursor"}'; exit 1 }
    $pick = Get-Pick $cursor.x $cursor.y
    if ($null -eq $pick) { Write-Output '{"error":"no element"}'; exit 1 }
    try {
        Send-Pick $pick
        Write-Output 'posted'
    } catch {
        Write-Output ('post failed: ' + $_.Exception.Message)
        exit 1
    }
    exit 0
}

Write-Output ('ready hotkey=' + $Hotkey + ' -> ' + $BaseUrl)
$wasDown = $false
while ($true) {
    try {
        $down = (Test-Down $vk)
        if ($wantCtrl) { $down = $down -and (Test-Down $VK_CONTROL) }
        if ($wantAlt) { $down = $down -and (Test-Down $VK_MENU) }
        if ($wantShift) { $down = $down -and (Test-Down $VK_SHIFT) }
        if ($wantWin) { $down = $down -and (Test-Down $VK_LWIN) }

        if ($down -and -not $wasDown) {
            $cursor = Get-CursorPoint
            if ($null -ne $cursor) {
                $pick = Get-Pick $cursor.x $cursor.y
                if ($null -ne $pick) {
                    try {
                        Send-Pick $pick
                        Write-Output ('picked ' + $pick.controlType + ' ' + $pick.name)
                    } catch {
                        Write-Output ('post failed: ' + $_.Exception.Message)
                    }
                }
            }
        }
        $wasDown = $down
    } catch {
        Write-Output ('loop error: ' + $_.Exception.Message)
    }
    Start-Sleep -Milliseconds $PollMs
}
