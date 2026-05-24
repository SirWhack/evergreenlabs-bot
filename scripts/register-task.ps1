# One-time setup: registers the daily autorun with Windows Task Scheduler.
# Run from a regular (non-admin) PowerShell. Re-run to update trigger/settings.
#
# What it does:
#   - Fires once a day at 09:00 local time.
#   - Triggers wsl.exe to run scripts/autorun.sh inside WSL.
#   - Runs whether on AC or battery; doesn't stop if you unplug.
#   - Output is logged to logs/autorun.YYYY-MM.log inside the bot repo.
#
# Prerequisite:
#   - LM Studio must be running on Windows at the time the task fires.
#     Otherwise the bot will fail (and you'll see Connection refused in the log).

$taskName = "evergreenlabs-bot autorun"
$wslScript = "/home/swynn/Code/evergreenlabs-bot/scripts/autorun.sh"

$action = New-ScheduledTaskAction `
  -Execute "wsl.exe" `
  -Argument "bash -lc `"$wslScript`""

$trigger = New-ScheduledTaskTrigger -Daily -At 9am

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

# Replace existing task if present
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Daily autonomous run of evergreenlabs-bot. Logs to repo's logs/ dir."

Write-Host ""
Write-Host "Registered '$taskName' to run daily at 9am." -ForegroundColor Green
Write-Host "To run on-demand:  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "To inspect logs:   wsl bash -c 'tail -n 50 /home/swynn/Code/evergreenlabs-bot/logs/autorun.\$(date +%Y-%m).log'"
Write-Host "To remove:         Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
