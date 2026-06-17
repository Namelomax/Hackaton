FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  libreoffice \
  libgl1 \
  libglib2.0-0 \
  fontconfig \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Скрипты миграции/опса (явный COPY — чтобы не потерялись при сборке со старым кэшем слоя COPY .)
COPY scripts/ ./scripts/
RUN chmod +x ./scripts/*.sh 2>/dev/null || true

COPY . .

RUN mkdir -p /app/uploads /app/output /app/rag_storage

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
