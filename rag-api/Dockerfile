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

# ── Работа без интернета (закрытый контур) ─────────────────────────────────
# LightRAG режет текст токенизатором tiktoken, а тот при первом вызове
# скачивает словарь с openaipublic.blob.core.windows.net. Кладём его в образ.
ENV TIKTOKEN_CACHE_DIR=/opt/tiktoken
RUN python -c "import tiktoken; tiktoken.get_encoding('cl100k_base'); tiktoken.get_encoding('o200k_base')"

# MinerU (разбор PDF/DOCX) при первом документе тянет модели с HuggingFace.
# PRELOAD_MINERU_MODELS=1 скачивает их при сборке и переключает MinerU на
# локальные файлы. Ошибка загрузки должна ронять сборку: образ, который
# молча полезет в интернет внутри контура, хуже, чем образ, который не собрался.
ARG PRELOAD_MINERU_MODELS=0
RUN if [ "$PRELOAD_MINERU_MODELS" = "1" ]; then \
      mineru-models-download --source huggingface --model_type pipeline \
      && test -f /root/mineru.json; \
    fi

# Скрипты миграции/опса (явный COPY — чтобы не потерялись при сборке со старым кэшем слоя COPY .)
COPY scripts/ ./scripts/
RUN chmod +x ./scripts/*.sh 2>/dev/null || true

COPY . .

RUN mkdir -p /app/uploads /app/output /app/rag_storage

EXPOSE 8000
# Локальные модели MinerU включаем, только если они реально скачаны при сборке.
CMD ["sh", "-c", "if [ -f /root/mineru.json ]; then export MINERU_MODEL_SOURCE=local; fi; exec uvicorn main:app --host 0.0.0.0 --port 8000"]
