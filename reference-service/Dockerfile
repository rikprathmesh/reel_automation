FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 STORAGE_ROOT=/storage HF_HOME=/models/hf \
    FFMPEG_PATH=ffmpeg FFPROBE_PATH=ffprobe AGENT_REACH_PATH=/home/ref/.local/bin/agent-reach
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 ref && mkdir -p /storage /models/hf && chown -R ref:ref /storage /models
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
USER ref
# Agent Reach: official install method (GitHub release via uv), never the unrelated PyPI package
RUN pip install --user uv && ~/.local/bin/uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip
COPY --chown=ref:ref app ./app
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s CMD curl -fsS http://localhost:8100/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
