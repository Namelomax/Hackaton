import json
import logging
import os
import subprocess
import shutil
import uuid
from pathlib import Path
import re

logger = logging.getLogger(__name__)
from lightrag.llm.openai import openai_embed, openai_complete_if_cache
from lightrag.utils import EmbeddingFunc
from raganything import RAGAnything, RAGAnythingConfig

BASE_URL = os.getenv("LOCAL_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1")
API_KEY = os.getenv("LOCAL_OPENAI_API_KEY", "lm-studio")
EMBEDDING_MODEL = os.getenv("LOCAL_OPENAI_EMBEDDING_MODEL", "text-embedding-nomic")

# Реальная LLM для индексации (entity/relation extraction в LightRAG). Без неё граф знаний пустой
# и Raw search results=0 даже после загрузки документов. По умолчанию используем тот же Ollama-эндпоинт.
LLM_BASE_URL = os.getenv("RAG_OLLAMA_BASE_URL", BASE_URL)
LLM_API_KEY = os.getenv("RAG_OLLAMA_API_KEY", API_KEY)
LLM_MODEL = os.getenv("RAG_OLLAMA_LLM_MODEL", "qwen3:14b")
# Таймаут одного LLM-вызова: индексация делает много обращений, локальная Ollama медленнее облака.
LLM_TIMEOUT = int(os.getenv("RAG_OLLAMA_LLM_TIMEOUT", "600"))


def log_openai_compat_embedding_settings() -> None:
    """Один раз при старте: фактический URL для /embeddings (частая ошибка — 127.0.0.1 внутри Docker)."""
    logger.info(
        "OpenAI-compatible API for embeddings: base_url=%s model=%s",
        BASE_URL,
        EMBEDDING_MODEL,
    )
    logger.info(
        "OpenAI-compatible API for indexing LLM: base_url=%s model=%s timeout=%ss",
        LLM_BASE_URL,
        LLM_MODEL,
        LLM_TIMEOUT,
    )
    for label, url in (("embeddings", BASE_URL), ("LLM", LLM_BASE_URL)):
        low = (url or "").lower()
        if "127.0.0.1" in low or "localhost" in low:
            logger.warning(
                "%s URL указывает на localhost/127.0.0.1. Внутри контейнера rag-api это НЕ хост "
                "и НЕ контейнер ollama — запросы дадут APIConnectionError. "
                "Задайте http://ollama:11434/v1 (имя сервиса из docker-compose).",
                label,
            )

_STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "is", "are", "was", "were",
    "be", "to", "of", "in", "on", "at", "as", "it", "by", "or", "not", "but", "we",
    "you", "i", "they", "them",
}


def _extract_meaningful_words(text: str, max_words: int = 40) -> list[str]:
    text_lower = (text or "").lower()
    words = re.findall(r"[A-Za-zА-Яа-я0-9]{3,}", text_lower)
    unique: list[str] = []
    for word in words:
        if word in _STOPWORDS or word in unique:
            continue
        unique.append(word)
        if len(unique) >= max_words:
            break
    return unique


def _extract_user_query_from_keyword_prompt(prompt_text: str) -> str:
    m = re.search(r"User Query:\s*(.+?)(?=\n---Output---|\Z)", prompt_text, re.S | re.I)
    if m:
        return m.group(1).strip()
    return (prompt_text or "").strip()


def _keywords_json_for_lightrag(prompt_text: str) -> str:
    """
    LightRAG extract_keywords_only ожидает от llm_model_func валидный JSON с ключами
    high_level_keywords / low_level_keywords (списки строк). Иначе — пустые keywords и пустой retrieval.
    """
    query_text = _extract_user_query_from_keyword_prompt(prompt_text)
    trivial = {
        "hello", "hi", "ok", "yes", "no", "thanks", "привет", "здравствуйте",
        "давай", "спасибо", "ок", "хорошо",
    }
    qn = query_text.lower().strip()
    if len(query_text) < 2 or qn in trivial:
        return json.dumps(
            {"high_level_keywords": [], "low_level_keywords": []},
            ensure_ascii=False,
        )

    parts = _extract_meaningful_words(query_text, max_words=35)
    if not parts:
        return json.dumps(
            {"high_level_keywords": [], "low_level_keywords": []},
            ensure_ascii=False,
        )

    if len(parts) == 1:
        high, low = [parts[0]], [parts[0]]
    elif len(parts) == 2:
        high, low = [parts[0]], [parts[1]]
    else:
        split = max(1, min(8, len(parts) // 3))
        high = parts[:split]
        low = parts[split:]

    return json.dumps(
        {
            "high_level_keywords": high[:12],
            "low_level_keywords": low[:25],
        },
        ensure_ascii=False,
    )


def _safe_log_preview(text: str | None, limit: int = 400) -> str:
    if not text:
        return ""
    s = re.sub(r"\s+", " ", str(text)).strip()
    if len(s) <= limit:
        return s
    return s[: limit - 1] + "…"

class RAGService:
    def __init__(self):
        self.rag = None
        self._initialized = False

    async def initialize(self):
        """Инициализация RAG один раз при старте (как в вашем main)"""
        if self._initialized:
            return

        config = RAGAnythingConfig(
            working_dir="./rag_storage",
            parser="mineru",
            # MinerU CLI поддерживает только: auto, txt, ocr
            parse_method="auto",
            # Без vision-модели картинки/формулы превращаются в мусор в графе. Таблицы оставляем (текстовые).
            enable_image_processing=False,
            enable_table_processing=True,
            enable_equation_processing=False,
        )

        async def llm_model_func(prompt, system_prompt=None, history_messages=[], **kwargs):
            """
            LLM для LightRAG: при keyword_extraction отдаём детерминированный JSON (быстро, без вызова Ollama),
            во всех остальных случаях — РЕАЛЬНЫЙ вызов Ollama. Без этого entity/relation extraction на этапе
            индексации возвращает мусор (слова из самого промпта) и граф знаний остаётся пустым.
            """
            prompt_text = prompt if isinstance(prompt, str) else str(prompt)
            if kwargs.get("keyword_extraction"):
                return _keywords_json_for_lightrag(prompt_text)
            try:
                return await openai_complete_if_cache(
                    LLM_MODEL,
                    prompt_text,
                    system_prompt=system_prompt,
                    history_messages=history_messages or [],
                    api_key=LLM_API_KEY,
                    base_url=LLM_BASE_URL,
                    timeout=LLM_TIMEOUT,
                )
            except Exception as e:
                logger.warning("LLM call failed (%s); returning empty completion", e)
                return ""

        embedding_func = EmbeddingFunc(
            embedding_dim=768,
            max_token_size=2000,
            func=lambda texts: openai_embed.func(
                texts,
                model=EMBEDDING_MODEL,
                api_key=API_KEY,
                base_url=BASE_URL,
            ),
        )

        # Всё как в вашем рабочем коде
        self.rag = RAGAnything(
            config=config,
            llm_model_func=llm_model_func,
            embedding_func=embedding_func,
            lightrag_kwargs={
                "llm_model_kwargs": {"timeout": 6000},
                "llm_model_max_async": 1,
                "chunk_token_size": 2000,
                "chunk_overlap_token_size": 150,
            },
        )

        self._initialized = True
        print("RAGAnything initialized")

        # RAGAnything creates LightRAG lazily inside process_document_complete(), after
        # doc_parser.check_installation(). Without MinerU CLI that gate never passes and
        # lightrag stays None — POST /query then raises (seen as HTTP 500) while upload
        # returns "queued" but indexing fails in the background.
        # Mark parser checked once so storages initialize at startup; ingest still runs MinerU
        # when processing files — MinerU must be installed in the image (requirements/Dockerfile).
        self.rag._parser_installation_checked = True
        bootstrap = await self.rag._ensure_lightrag_initialized()
        if isinstance(bootstrap, dict) and bootstrap.get("success") is False:
            print(f"WARNING: LightRAG bootstrap failed: {bootstrap.get('error')}")
        else:
            print("LightRAG storages ready")
            log_openai_compat_embedding_settings()

    def _convert_office_to_pdf(self, file_path: str) -> str:
        source_path = Path(file_path).resolve()
        output_dir = source_path.parent
        pdf_path = output_dir / f"{source_path.stem}.pdf"

        subprocess.run(
            [
                "soffice",
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                str(output_dir),
                str(source_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        if not pdf_path.exists():
            raise RuntimeError(f"PDF conversion failed for: {source_path.name}")

        return str(pdf_path)

    async def process_document(self, file_path: str) -> dict:
        """Обработка документа — как у вас в main"""
        try:
            safe_name = os.path.basename(file_path) or file_path
            logger.info("Processing document: %s", safe_name)
            extension = Path(file_path).suffix.lower()
            source_for_processing = file_path
            cleanup_pdf: str | None = None

            if extension in {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf"}:
                source_for_processing = self._convert_office_to_pdf(file_path)
                cleanup_pdf = source_for_processing
                logger.info("Converted to PDF: %s", os.path.basename(source_for_processing))

            # MinerU on Windows can fail with long/non-ASCII temp names.
            # Normalize to a short ASCII filename before parsing.
            normalized_ext = Path(source_for_processing).suffix.lower() or ".pdf"
            normalized_name = f"rag_input_{uuid.uuid4().hex}{normalized_ext}"
            normalized_path = str(Path("uploads") / normalized_name)
            shutil.copy2(source_for_processing, normalized_path)

            try:
                await self.rag.process_document_complete(
                    file_path=normalized_path,
                    output_dir="./output",
                    backend="pipeline",
                )
            finally:
                if os.path.exists(normalized_path):
                    os.remove(normalized_path)

            if cleanup_pdf and os.path.exists(cleanup_pdf):
                os.remove(cleanup_pdf)

            logger.info(
                "Ingest finished file=%s (normalized temp removed). "
                "Duplicate doc in LightRAG = chunks already in graph.",
                safe_name,
            )
            return {"status": "success", "message": "Документ обработан"}
        except Exception as e:
            logger.exception("Error while processing document: %s", os.path.basename(file_path))
            return {"status": "error", "message": str(e)}

    async def query(self, question: str, mode: str = "hybrid") -> str:
        """Запрос к RAG — как у вас в основном коде"""
        if self.rag is None:
            return ""
        if getattr(self.rag, "lightrag", None) is None:
            logger.warning("LightRAG missing; skipping RAG query")
            return ""

        qprev = (question or "").replace("\n", " ").strip()
        if len(qprev) > 160:
            qprev = qprev[:160] + "…"
        logger.info("RAG /query request mode=%s len=%s preview=%r", mode, len(question or ""), qprev)

        def _normalize_result(result) -> str:
            if result is None:
                return ""
            if isinstance(result, str):
                return result
            if isinstance(result, dict):
                ans = result.get("answer")
                if isinstance(ans, str):
                    return ans
                return str(result)
            return str(result)

        async def _run_once(m: str):
            return await self.rag.aquery(
                question,
                mode=m,
                enable_rerank=False,
                top_k=20,
                only_need_context=True,
            )

        used_mode = mode
        try:
            result = await _run_once(mode)
        except Exception as e:
            logger.warning("RAG /query primary mode=%s error: %s", mode, e)
            result = None

        text = _normalize_result(result).strip()
        # Сигнал «нечего отдавать» из LightRAG: повторные вызовы local/global тоже вернут это.
        looks_no_context = (
            not text
            or "[no-context]" in text.lower()
            or "no-result" in text.lower()
            or "i'm not able to provide an answer" in text.lower()
        )
        if not looks_no_context and len(text) < 80 and mode == "hybrid":
            for fb in ("local", "global"):
                try:
                    r2 = await _run_once(fb)
                    t2 = _normalize_result(r2).strip()
                    if len(t2) > len(text) and "[no-context]" not in t2.lower():
                        text = t2
                        used_mode = fb
                except Exception as e:
                    logger.debug("RAG /query fallback mode=%s: %s", fb, e)
        if looks_no_context:
            text = ""

        logger.info(
            "RAG /query response mode_used=%s context_len=%s preview=%r",
            used_mode,
            len(text),
            _safe_log_preview(text, 450),
        )
        return text

    def list_indexed_documents(self) -> list[dict]:
        """Список документов в индексе LightRAG (по kv_store)."""
        base = Path("./rag_storage")
        by_id: dict[str, dict] = {}
        status_path = base / "kv_store_doc_status.json"
        if status_path.exists():
            try:
                data = json.loads(status_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    for doc_id, payload in data.items():
                        if not isinstance(doc_id, str) or not doc_id.strip():
                            continue
                        name = doc_id
                        st = ""
                        if isinstance(payload, dict):
                            st = str(payload.get("status") or "")
                            fp = payload.get("file_path") or payload.get("path")
                            if fp:
                                name = os.path.basename(str(fp)) or doc_id
                        by_id[doc_id] = {"id": doc_id, "filename": name, "status": st}
            except Exception:
                pass

        full_path = base / "kv_store_full_docs.json"
        if full_path.exists():
            try:
                data = json.loads(full_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    for doc_id in data.keys():
                        if not isinstance(doc_id, str) or doc_id in by_id:
                            continue
                        by_id[doc_id] = {"id": doc_id, "filename": doc_id, "status": ""}
            except Exception:
                pass
        return sorted(by_id.values(), key=lambda x: x["id"])

    async def delete_indexed_document(self, doc_id: str) -> dict:
        """Удаление документа из индекса LightRAG по id."""
        if not doc_id or not str(doc_id).strip():
            return {"ok": False, "error": "empty id"}
        if self.rag is None or getattr(self.rag, "lightrag", None) is None:
            return {"ok": False, "error": "RAG not initialized"}
        lr = self.rag.lightrag
        try:
            if hasattr(lr, "adelete_by_doc_id"):
                await lr.adelete_by_doc_id(doc_id)
            elif hasattr(lr, "delete_by_doc_id"):
                maybe = lr.delete_by_doc_id(doc_id)
                if hasattr(maybe, "__await__"):
                    await maybe
            else:
                return {"ok": False, "error": "delete_by_doc_id not supported in this LightRAG version"}
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def cleanup(self) -> None:
        """Graceful shutdown hook for FastAPI lifespan."""
        self.rag = None
        self._initialized = False