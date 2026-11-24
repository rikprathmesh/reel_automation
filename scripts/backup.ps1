# ReelForge AI - backup: PostgreSQL dump + mirror of generated media (storage/).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 [-Dest D:\reelforge-backups] [-Keep 14]
# Schedule daily with Windows Task Scheduler (Action: powershell.exe, Arguments: the line above).
param([string]$Dest = "D:\reelforge-backups", [int]$Keep = 14)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pgBin = "C:\Program Files\PostgreSQL\18\bin"
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
New-Item -ItemType Directory -Force "$Dest\db", "$Dest\storage" | Out-Null

# Read DATABASE_URL from backend/.env (never printed)
$line = Get-Content "$root\backend\.env" | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if (-not $line) { throw "DATABASE_URL not found in backend\.env" }
$uri = [Uri]($line -replace '^DATABASE_URL=', '')
$user, $pass = $uri.UserInfo.Split(':', 2)
$env:PGPASSWORD = [Uri]::UnescapeDataString($pass)
try {
    # 1. database: custom-format dump (compressed, restorable table by table)
    & "$pgBin\pg_dump.exe" -h $uri.Host -p $uri.Port -U $user -d $uri.AbsolutePath.TrimStart('/') -Fc -f "$Dest\db\reelforge-$stamp.dump"
    if ($LASTEXITCODE -ne 0) { throw "pg_dump failed ($LASTEXITCODE)" }
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }

# 2. media: incremental mirror, excluding scratch folders
robocopy "$root\storage" "$Dest\storage" /MIR /XD work /R:1 /W:1 /NFL /NDL /NJH /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

# 3. retention
Get-ChildItem "$Dest\db\*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep | Remove-Item -Force

Write-Host "Backup complete: $Dest\db\reelforge-$stamp.dump + storage mirror"
