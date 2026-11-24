# ReelForge AI - restore a database dump made by backup.ps1 (and optionally the media mirror).
# Stop the backend first. Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\restore.ps1 -Dump D:\reelforge-backups\db\reelforge-YYYYMMDD-HHmm.dump [-WithStorage]
param([Parameter(Mandatory = $true)][string]$Dump, [string]$BackupRoot = "D:\reelforge-backups", [switch]$WithStorage)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pgBin = "C:\Program Files\PostgreSQL\18\bin"
if (-not (Test-Path $Dump)) { throw "Dump not found: $Dump" }

$line = Get-Content "$root\backend\.env" | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
$uri = [Uri]($line -replace '^DATABASE_URL=', '')
$user, $pass = $uri.UserInfo.Split(':', 2)
$db = $uri.AbsolutePath.TrimStart('/')

$answer = Read-Host "This replaces ALL data in database '$db' with $Dump. Type RESTORE to continue"
if ($answer -ne "RESTORE") { Write-Host "Cancelled."; exit 1 }

$env:PGPASSWORD = [Uri]::UnescapeDataString($pass)
try {
    & "$pgBin\pg_restore.exe" -h $uri.Host -p $uri.Port -U $user -d $db --clean --if-exists --no-owner $Dump
    if ($LASTEXITCODE -ne 0) { throw "pg_restore failed ($LASTEXITCODE)" }
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }

if ($WithStorage) {
    robocopy "$BackupRoot\storage" "$root\storage" /MIR /XD work /R:1 /W:1 /NFL /NDL /NJH /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
}
Write-Host "Restore complete. Start the backend again."
