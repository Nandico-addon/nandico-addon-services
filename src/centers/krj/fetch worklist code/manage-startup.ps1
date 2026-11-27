param(
    [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Remove')]
    [string]$Action = 'Status',
    [ValidateSet('Auto', 'Logon', 'Boot')]
    [string]$StartupMode = 'Auto'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userTaskName = 'KRJWorklist-' + $identity.User.Value
$bootTaskName = 'KRJWorklist-Boot'
if ($StartupMode -eq 'Auto') {
    $StartupMode = if (Get-ScheduledTask -TaskName $bootTaskName -ErrorAction SilentlyContinue) { 'Boot' } else { 'Logon' }
}
if ($StartupMode -eq 'Boot') {
    $windowsPrincipal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $windowsPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        # A boot task running before sign-in needs Windows administrator rights.
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action {1} -StartupMode Boot' -f $PSCommandPath, $Action
        $elevated = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
        exit $elevated.ExitCode
    }
}
$taskName = if ($StartupMode -eq 'Boot') { $bootTaskName } else { $userTaskName }
$executable = Join-Path $PSScriptRoot 'KRJWorklist.exe'
switch ($Action) {
    'Install' {
        if (-not (Test-Path $executable -PathType Leaf) -or
            -not (Test-Path (Join-Path $PSScriptRoot 'config.txt') -PathType Leaf)) {
            throw 'Keep manage-startup.ps1, KRJWorklist.exe and config.txt together in the installed app folder.'
        }
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            throw 'KRJ startup is already installed for this user. Use Start, or Remove before moving the app.'
        }
        $otherTaskName = if ($StartupMode -eq 'Boot') { $userTaskName } else { $bootTaskName }
        if (Get-ScheduledTask -TaskName $otherTaskName -ErrorAction SilentlyContinue) {
            throw 'A KRJ startup task already exists in the other mode. Remove it before switching startup modes.'
        }
        $taskAction = New-ScheduledTaskAction -Execute $executable -WorkingDirectory $PSScriptRoot
        if ($StartupMode -eq 'Boot') {
            $trigger = New-ScheduledTaskTrigger -AtStartup
            $trigger.Delay = 'PT30S'
            $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Limited
        } else {
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
            $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
        }
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger `
            -Principal $principal -Settings $settings -Description "KRJ DICOM worklist; startup mode: $StartupMode." | Out-Null
        Start-ScheduledTask -TaskName $taskName
        Write-Host "Startup installed ($StartupMode) and launch requested. Check Status and krj-worklist.log for listener health."
    }
    'Start' { Start-ScheduledTask -TaskName $taskName }
    'Stop' { Stop-ScheduledTask -TaskName $taskName }
    'Status' {
        Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
        Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, LastTaskResult
    }
    'Remove' {
        Stop-ScheduledTask -TaskName $taskName
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host 'KRJ startup removed. Configuration and logs are preserved.'
    }
}
