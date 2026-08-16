FROM python:3.11-slim-bookworm

ARG MODEL_URL=https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs1-1.pb
ARG MODEL_SHA256=58a577a603669b922589179bd85ae06031fe642ffcc0ee873d2d79fbfc0ff8e5

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CUDA_VISIBLE_DEVICES=-1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /worker

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

RUN mkdir -p /opt/models \
    && curl --fail --location --connect-timeout 15 \
       --speed-limit 1024 --speed-time 30 \
       --retry 5 --retry-delay 2 --retry-all-errors \
       "$MODEL_URL" --output /opt/models/discogs-effnet-bs1-1.pb \
    && echo "$MODEL_SHA256  /opt/models/discogs-effnet-bs1-1.pb" \
       | sha256sum --check --strict

COPY worker.py ./

RUN useradd --create-home --uid 10001 worker \
    && chown -R worker:worker /worker /opt/models

USER worker

CMD ["python", "worker.py"]
