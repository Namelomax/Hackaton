import asyncio
import hashlib
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

LLM_BASE_URL = os.getenv("RAG_OLLAMA_BASE_URL", BASE_URL)
LLM_API_KEY = os.getenv("RAG_OLLAMA_API_KEY", API_KEY)
LLM_MODEL = os.getenv("RAG_OLLAMA_LLM_MODEL", "qwen3:14b")
LLM_TIMEOUT = int(os.getenv("RAG_OLLAMA_LLM_TIMEOUT", "600"))


def log_openai_compat_embedding_settings() -> None:
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


def _hash_file_contents(file_path: str, chunk_size: int = 1 << 20) -> str:
    h = hashlib.sha1()
    with open(file_path, "rb") as f:
        while True:
            block = f.read(chunk_size)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _sanitize_conv_id(conversation_id: str | None) -> str | None:
    """Нормализует conversation_id для использования как имя директории.
    Возвращает None для дефолтного индекса.
    """
    if not conversation_id or not conversation_id.strip():
        return None
    cid = conversation_id.strip()
    # Убираем префикс вида "conversations:"
    if ":" in cid:
        cid = cid.rsplit(":", 1)[-1]
    cid = re.sub(r"[^\w\-]", "_", cid)[:64]
    return cid or None


class _ConvData:
    """Состояние одного RAG-индекса (для одного диалога или дефолтного)."""

    def __init__(self, working_dir: str):
        self.working_dir = working_dir
        self.rag: RAGAnything | None = None
        self.initialized = False
        self.init_lock: asyncio.Lock = asyncio.Lock()
        self.hash_locks: dict[str, asyncio.Lock] = {}
        self.indexed_hashes: set[str] = set()
        # sha1 → [doc_id, ...] — для очистки indexed_hashes при удалении
        self.hash_to_doc_ids: dict[str, list[str]] = {}
        self.filename_map_path = Path(working_dir) / "filename_map.json"
        self.filename_map: dict[str, str] = self._load_filename_map()

    def _load_filename_map(self) -> dict[str, str]:
        try:
            if self.filename_map_path.exists():
                data = json.loads(self.filename_map_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return {str(k): str(v) for k, v in data.items()}
        except Exception:
            pass
        return {}

    def save_filename_map(self) -> None:
        try:
            self.filename_map_path.parent.mkdir(parents=True, exist_ok=True)
            self.filename_map_path.write_text(
                json.dumps(self.filename_map, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning("Could not save filename_map: %s", e)

    def resolve_display_name(self, doc_id: str, fallback: str) -> str:
        return self.filename_map.get(doc_id) or self.filename_map.get(fallback) or fallback

    @staticmethod
    def is_visible_doc(doc_id: str, status: str) -> bool:
        if not isinstance(doc_id, str) or not doc_id.strip():
            return False
        if doc_id.startswith("dup-"):
            return False
        if (status or "").strip().upper() == "FAILED":
            return False
        return True

    def list_documents(self) -> list[dict]:
        base = Path(self.working_dir)
        by_id: dict[str, dict] = {}
        status_path = base / "kv_store_doc_status.json"
        if status_path.exists():
            try:
                data = json.loads(status_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    for doc_id, payload in data.items():
                        raw_name = doc_id if isinstance(doc_id, str) else ""
                        st = ""
                        if isinstance(payload, dict):
                            st = str(payload.get("status") or "")
                            fp = payload.get("file_path") or payload.get("path")
                            if fp:
                                raw_name = os.path.basename(str(fp)) or raw_name
                        if not self.is_visible_doc(doc_id, st):
                            continue
                        display = self.resolve_display_name(doc_id, raw_name)
                        by_id[doc_id] = {"id": doc_id, "filename": display, "status": st}
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
                        if not self.is_visible_doc(doc_id, ""):
                            continue
                        display = self.resolve_display_name(doc_id, doc_id)
                        by_id[doc_id] = {"id": doc_id, "filename": display, "status": ""}
            except Exception:
                pass
        return sorted(by_id.values(), key=lambda x: x["id"])


class RAGService:
    def __init__(self):
        # Дефолтный индекс — использует ./rag_storage/ (обратная совместимость)
        self._default_data = _ConvData("./rag_storage")
        # Индексы по диалогам: sanitized_conv_id → _ConvData
        self._conv_data: dict[str, _ConvData] = {}
        self._conv_data_lock: asyncio.Lock = asyncio.Lock()

    # ─── инициализация ───────────────────────────────────────────────────────

    async def initialize(self):
        """Загружаем дефолтный индекс при старте."""
        await self._ensure_initialized(self._default_data)
        print("RAG service ready")
        log_openai_compat_embedding_settings()

    async def _ensure_initialized(self, data: _ConvData) -> None:
        if data.initialized:
            return
        async with data.init_lock:
            if data.initialized:
                return
            await self._bootstrap_rag(data)
            data.initialized = True

    async def _bootstrap_rag(self, data: _ConvData) -> None:
        os.makedirs(data.working_dir, exist_ok=True)

        config = RAGAnythingConfig(
            working_dir=data.working_dir,
            parser="mineru",
            parse_method="auto",
            enable_image_processing=False,
            enable_table_processing=True,
            enable_equation_processing=False,
        )

        async def llm_model_func(prompt, system_prompt=None, history_messages=[], **kwargs):
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

        data.rag = RAGAnything(
            config=config,
            llm_model_func=llm_model_func,
            embedding_func=embedding_func,
            lightrag_kwargs={
                "llm_model_kwargs": {"timeout": 6000},
                "llm_model_max_async": 3,
                "chunk_token_size": 200,
                "chunk_overlap_token_size": 80,
                "vector_db_storage_cls_kwargs": {"cosine_better_than_threshold": 0.1},
                "addon_params": {"language": "Russian"},
            },
        )

        data.rag._parser_installation_checked = True
        bootstrap = await data.rag._ensure_lightrag_initialized()
        if isinstance(bootstrap, dict) and bootstrap.get("success") is False:
            logger.warning("LightRAG bootstrap failed for %s: %s", data.working_dir, bootstrap.get("error"))
        else:
            logger.info("LightRAG storages ready for working_dir=%s", data.working_dir)

    async def _get_conv_data(self, conversation_id: str | None) -> _ConvData:
        cid = _sanitize_conv_id(conversation_id)
        if cid is None:
            await self._ensure_initialized(self._default_data)
            return self._default_data

        if cid not in self._conv_data:
            async with self._conv_data_lock:
                if cid not in self._conv_data:
                    working_dir = f"./rag_storage/conv_{cid}"
                    self._conv_data[cid] = _ConvData(working_dir)

        data = self._conv_data[cid]
        await self._ensure_initialized(data)
        return data

    # ─── конвертация Office → PDF ─────────────────────────────────────────────

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

    # ─── обработка документа ─────────────────────────────────────────────────

    async def process_document(
        self,
        file_path: str,
        original_filename: str | None = None,
        conversation_id: str | None = None,
    ) -> dict:
        data = await self._get_conv_data(conversation_id)
        return await self._process_document_for_data(data, file_path, original_filename)

    async def _process_document_for_data(
        self, data: _ConvData, file_path: str, original_filename: str | None
    ) -> dict:
        safe_name = os.path.basename(file_path) or file_path
        if not os.path.exists(file_path):
            logger.warning("process_document: source missing: %s", safe_name)
            return {"status": "error", "message": "source file missing"}

        try:
            content_hash = _hash_file_contents(file_path)
        except Exception as hash_err:
            logger.warning("process_document: hashing failed (%s), skipping dedup", hash_err)
            content_hash = ""

        lock = None
        if content_hash:
            lock = data.hash_locks.setdefault(content_hash, asyncio.Lock())

        async def _do_process() -> dict:
            if content_hash and content_hash in data.indexed_hashes:
                logger.info(
                    "process_document: same content already indexed (sha1=%s) — skipping. file=%s",
                    content_hash[:8],
                    safe_name,
                )
                return {"status": "success", "message": "Документ уже в индексе (дубликат содержимого)"}

            try:
                logger.info("Processing document: %s (sha1=%s)", safe_name, content_hash[:8] if content_hash else "n/a")
                extension = Path(file_path).suffix.lower()
                source_for_processing = file_path
                cleanup_pdf: str | None = None

                if extension in {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf"}:
                    source_for_processing = self._convert_office_to_pdf(file_path)
                    cleanup_pdf = source_for_processing
                    logger.info("Converted to PDF: %s", os.path.basename(source_for_processing))

                normalized_ext = Path(source_for_processing).suffix.lower() or ".pdf"
                normalized_name = f"rag_input_{uuid.uuid4().hex}{normalized_ext}"
                normalized_path = str(Path("uploads") / normalized_name)
                shutil.copy2(source_for_processing, normalized_path)

                display_name = original_filename or safe_name
                data.filename_map[normalized_name] = display_name
                data.save_filename_map()

                try:
                    await data.rag.process_document_complete(
                        file_path=normalized_path,
                        output_dir="./output",
                        backend="pipeline",
                    )
                finally:
                    if os.path.exists(normalized_path):
                        os.remove(normalized_path)

                if cleanup_pdf and os.path.exists(cleanup_pdf):
                    os.remove(cleanup_pdf)

                if content_hash:
                    data.indexed_hashes.add(content_hash)

                logger.info(
                    "Ingest finished file=%s (normalized temp removed).",
                    safe_name,
                )
                return {"status": "success", "message": "Документ обработан"}
            except Exception as e:
                logger.exception("Error while processing document: %s", safe_name)
                return {"status": "error", "message": str(e)}

        if lock is None:
            return await _do_process()
        async with lock:
            return await _do_process()

    # ─── запрос к RAG ─────────────────────────────────────────────────────────

    async def query(
        self,
        question: str,
        mode: str = "hybrid",
        conversation_id: str | None = None,
    ) -> str:
        data = await self._get_conv_data(conversation_id)
        if data.rag is None:
            return ""
        if getattr(data.rag, "lightrag", None) is None:
            logger.warning("LightRAG missing for conv=%s; skipping RAG query", conversation_id)
            return ""

        qprev = (question or "").replace("\n", " ").strip()
        if len(qprev) > 160:
            qprev = qprev[:160] + "…"
        logger.info(
            "RAG /query request conv=%s mode=%s len=%s preview=%r",
            conversation_id or "default",
            mode,
            len(question or ""),
            qprev,
        )

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
            return await data.rag.aquery(
                question,
                mode=m,
                enable_rerank=False,
                top_k=20,
                chunk_top_k=15,
                only_need_context=True,
            )

        used_mode = mode
        try:
            result = await _run_once(mode)
        except Exception as e:
            logger.warning("RAG /query primary mode=%s error: %s", mode, e)
            result = None

        text = _normalize_result(result).strip()
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

    # ─── список и удаление документов ────────────────────────────────────────

    def list_indexed_documents(self, conversation_id: str | None = None) -> list[dict]:
        """Список документов для конкретного диалога (или дефолтного индекса)."""
        cid = _sanitize_conv_id(conversation_id)
        if cid is None:
            data = self._default_data
        else:
            data = self._conv_data.get(cid)
            if data is None:
                # Индекс ещё не инициализирован — читаем файл напрямую без инициализации RAG
                working_dir = f"./rag_storage/conv_{cid}"
                data = _ConvData(working_dir)
        return data.list_documents()

    async def _clear_from_doc_status(self, data: "_ConvData", doc_id: str) -> None:
        """Удаляет doc_id (и все dup-* записи) из kv_store_doc_status.json.

        LightRAG's adelete_by_doc_id удаляет чанки/графы/векторы, но НЕ трогает kv_store_doc_status.
        Из-за этого повторная загрузка того же файла блокируется как «дубликат» —
        LightRAG видит doc_id в статус-сторе и отказывается вставлять.
        """
        lr = data.rag.lightrag if data.rag else None

        # Пробуем через внутренний KV-стор LightRAG (если API доступно)
        if lr and hasattr(lr, "doc_status"):
            kv = lr.doc_status
            try:
                if hasattr(kv, "delete"):
                    await kv.delete([doc_id])
                elif hasattr(kv, "drop"):
                    await kv.drop([doc_id])
            except Exception as e:
                logger.debug("LightRAG doc_status.delete failed (%s), falling back to file patch", e)

        # Надёжный fallback: напрямую правим JSON-файл
        status_path = Path(data.working_dir) / "kv_store_doc_status.json"
        if not status_path.exists():
            return
        try:
            raw = json.loads(status_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return
            changed = False
            if doc_id in raw:
                del raw[doc_id]
                changed = True
            # Dup-* записи — артефакты повторных загрузок, тоже блокируют re-insert
            for key in list(raw.keys()):
                if key.startswith("dup-"):
                    del raw[key]
                    changed = True
            if changed:
                status_path.write_text(
                    json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                logger.info("Patched kv_store_doc_status.json: removed %r + dup-* entries", doc_id)
        except Exception as e:
            logger.warning("Could not patch kv_store_doc_status.json: %s", e)

    async def delete_indexed_document(
        self, doc_id: str, conversation_id: str | None = None
    ) -> dict:
        data = await self._get_conv_data(conversation_id)
        if not doc_id or not str(doc_id).strip():
            return {"ok": False, "error": "empty id"}
        if data.rag is None or getattr(data.rag, "lightrag", None) is None:
            return {"ok": False, "error": "RAG not initialized"}
        lr = data.rag.lightrag
        try:
            if hasattr(lr, "adelete_by_doc_id"):
                await lr.adelete_by_doc_id(doc_id)
            elif hasattr(lr, "delete_by_doc_id"):
                maybe = lr.delete_by_doc_id(doc_id)
                if hasattr(maybe, "__await__"):
                    await maybe
            else:
                return {"ok": False, "error": "delete_by_doc_id not supported in this LightRAG version"}

            # Чистим doc_status — ключевой шаг, без него тот же файл не пройдёт re-insert
            await self._clear_from_doc_status(data, doc_id)

            # Сбрасываем sha1-кэш сессии — разрешаем повторную загрузку того же контента
            data.indexed_hashes.clear()

            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def prune_failed_documents(self, conversation_id: str | None = None) -> dict:
        data = await self._get_conv_data(conversation_id)
        if data.rag is None or getattr(data.rag, "lightrag", None) is None:
            return {"ok": False, "error": "RAG not initialized"}

        status_path = Path(data.working_dir) / "kv_store_doc_status.json"
        targets: list[str] = []
        if status_path.exists():
            try:
                raw = json.loads(status_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    for did, payload in raw.items():
                        if not isinstance(did, str) or not did.strip():
                            continue
                        st = ""
                        if isinstance(payload, dict):
                            st = str(payload.get("status") or "").strip().upper()
                        if did.startswith("dup-") or st == "FAILED":
                            targets.append(did)
            except Exception as e:
                return {"ok": False, "error": f"failed to read doc_status: {e}"}

        deleted: list[str] = []
        errors: list[dict] = []
        for did in targets:
            res = await self.delete_indexed_document(did, conversation_id)
            if res.get("ok"):
                deleted.append(did)
            else:
                errors.append({"id": did, "error": res.get("error")})
        return {"ok": True, "deleted": deleted, "errors": errors, "deleted_count": len(deleted)}

    async def cleanup(self) -> None:
        self._default_data.rag = None
        for data in self._conv_data.values():
            data.rag = None
