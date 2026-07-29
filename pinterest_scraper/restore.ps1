# Restore a single file from the Windows Recycle Bin back to its original folder.
# Language-independent (uses MoveHere, not the localized "Restore" verb).
param(
  [Parameter(Mandatory=$true)][string]$dest,
  [Parameter(Mandatory=$true)][string]$fname
)
$ErrorActionPreference = "Stop"
$stem = [System.IO.Path]::GetFileNameWithoutExtension($fname)
$shell = New-Object -ComObject Shell.Application
$rb = $shell.Namespace(0xA)   # 0xA = Recycle Bin
$match = $null
$best = [datetime]::MinValue
foreach ($item in $rb.Items()) {
  $from = $item.ExtendedProperty("System.Recycle.DeletedFrom")
  if ($from -eq $dest -and ($item.Name -eq $stem -or $item.Name -eq $fname)) {
    $dd = $item.ExtendedProperty("System.Recycle.DateDeleted")
    if ($dd -ge $best) { $best = $dd; $match = $item }   # pick the most recent
  }
}
if ($null -eq $match) { Write-Output "NOTFOUND"; exit }
$shell.Namespace($dest).MoveHere($match)
Start-Sleep -Milliseconds 300
if (Test-Path (Join-Path $dest $fname)) { Write-Output "OK" } else { Write-Output "FAIL" }
