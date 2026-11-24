# ReelForge AI - start every local service in its own visible window.
# PostgreSQL (Windows service) and Ollama (tray app) are expected to be running already.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 [-NoComfy]
param([switch]$NoComfy)

$root = Split-Path -Parent $PSScriptRoot
$redis = "D:\tools\redis\Redis-8.10.3-Windows-x64-msys2"

function Start-Window($title, $dir, $cmd) {
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle='$title'; Set-Location '$dir'; $cmd" | Out-Null
    Write-Host "started: $title"
}

# 1. Redis (job queue)
if (-not (Get-NetTCPConnection -LocalPort 6379 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Window "ReelForge - Redis" $redis ".\redis-server.exe reelforge.conf"
} else { Write-Host "Redis already running" }

# 2. ComfyUI (image generation, CPU) - heavy: ~4-5 GB RAM
if (-not $NoComfy) {
    Start-Window "ReelForge - ComfyUI" "D:\ai-models\ComfyUI" ".\.venv\Scripts\python.exe main.py --cpu --listen 127.0.0.1 --port 8188 --disable-auto-launch"
}

# 3. Python services
Start-Window "ReelForge - reference-service :8100" "$root\reference-service" ".\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8100"
Start-Window "ReelForge - media-service :8000" "$root\media-service" "`$env:HF_HOME='D:/ai-models/hf'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000"

# 4. Backend (build once, then run) and frontend
Start-Window "ReelForge - backend :4000" "$root\backend" "npm run build; if (`$?) { npm start }"
Start-Window "ReelForge - frontend :3000" "$root\frontend" "npm run dev"

Write-Host ""
Write-Host "Open http://localhost:3000 in about a minute. Health: http://127.0.0.1:4000/api/health"
Write-Host "To stop: close the service windows."
