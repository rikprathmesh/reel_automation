# ReelForge AI - start ONE local service in its own visible window (used by the dashboard "Start" buttons).
# Does nothing if the service's port is already listening, so pressing Start twice never starts two copies.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\start-service.ps1 -Name media
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("redis", "comfyui", "media", "reference", "llm", "database")]
    [string]$Name
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$redisDir = "D:\tools\redis\Redis-8.10.3-Windows-x64-msys2"
$comfyDir = "D:\ai-models\ComfyUI"
$ollamaApp = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"

function Test-Port($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

function Start-Window($title, $dir, $cmd) {
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle='$title'; Set-Location '$dir'; $cmd" | Out-Null
}

switch ($Name) {
    "redis" {
        if (Test-Port 6379) { "already running"; break }
        Start-Window "ReelForge - Redis" $redisDir ".\redis-server.exe reelforge.conf"
        "started"
    }
    "comfyui" {
        if (Test-Port 8188) { "already running"; break }
        Start-Window "ReelForge - ComfyUI" $comfyDir ".\.venv\Scripts\python.exe main.py --cpu --listen 127.0.0.1 --port 8188 --disable-auto-launch"
        "started"
    }
    "media" {
        if (Test-Port 8000) { "already running"; break }
        Start-Window "ReelForge - media-service :8000" "$root\media-service" "`$env:HF_HOME='D:/ai-models/hf'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
        "started"
    }
    "reference" {
        if (Test-Port 8100) { "already running"; break }
        Start-Window "ReelForge - reference-service :8100" "$root\reference-service" ".\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8100"
        "started"
    }
    "llm" {
        if (Test-Port 11434) { "already running"; break }
        if (-not (Test-Path $ollamaApp)) { throw "Ollama is not installed at $ollamaApp" }
        Start-Process $ollamaApp | Out-Null
        "started"
    }
    "database" {
        if (Test-Port 5432) { "already running"; break }
        $svc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $svc) { throw "No PostgreSQL Windows service found" }
        try { Start-Service $svc.Name } catch { throw "PostgreSQL needs administrator rights to start: run 'Start-Service $($svc.Name)' in an admin PowerShell, or start it from services.msc" }
        "started"
    }
}
