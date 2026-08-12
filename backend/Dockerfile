FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=off \
    POETRY_VIRTUALENVS_CREATE=false

WORKDIR /app

# system deps for some pipecat extras (audio models, ffmpeg if used)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ffmpeg \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# copy requirements and install
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -r /app/requirements.txt

# copy app
COPY . /app

# expose port (Render will override PORT env)
EXPOSE 8000

# Use uvicorn to run FastAPI server; Render sets $PORT automatically.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "$PORT"]
