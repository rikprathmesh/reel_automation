FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    STORAGE_ROOT=/storage HF_HOME=/models/hf PIPER_VOICES_DIR=/models/piper

# ffmpeg (with libass) for rendering, espeak-ng for Kokoro's phonemizer, fonts for burned captions
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg espeak-ng fonts-dejavu-core fontconfig curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# CPU-only torch keeps the image small; swap the index URL for a CUDA build if you have a GPU.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch \
    && pip install -r requirements.txt

COPY app ./app
COPY workflows ./workflows

RUN useradd --create-home --uid 1000 media \
    && mkdir -p /storage /models/hf /models/piper && chown -R media:media /storage /models /app
USER media

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s CMD curl -fsS http://localhost:8000/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
