import json
import logging
import os
import subprocess
import shutil
import uuid
from pathlib import Path
import re

logger = logging.getLogger(__name__)
from lightrag.llm.openai import openai_embed
from lightrag.utils import EmbeddingFunc
from raganything import RAGAnything, RAGAnythingConfig

BASE_URL = os.getenv("LOCAL_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1")
API_KEY = os.getenv("LOCAL_OPENAI_API_KEY", "lm-studio")
EMBEDDING_MODEL = os.getenv("LOCAL_OPENAI_EMBEDDING_MODEL", "text-embedding-nomic")

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
        )

        stopwords = {
            "the",
            "and",
            "for",
            "with",
            "from",
            "that",
            "this",
            "is",
            "are",
            "was",
            "were",
            "be",
            "to",
            "of",
            "in",
            "on",
            "at",
            "as",
            "it",
            "by",
            "or",
            "not",
            "but",
            "we",
            "you",
            "i",
            "they",
            "them",
        }

        def extract_keywords(text: str) -> str:
            text_lower = text.lower()
            words = re.findall(r"[A-Za-zА-Яа-я0-9]{3,}", text_lower)

            unique: list[str] = []
            for word in words:
                if word in stopwords:
                    continue
                if word in unique:
                    continue
                unique.append(word)
                if len(unique) >= 25:
                    break

            if len(unique) == 0:
                return "keywords"

            return ", ".join(unique)

        async def llm_model_func(prompt, system_prompt=None, history_messages=[], **kwargs):
            prompt_text = prompt if isinstance(prompt, str) else str(prompt)
            return extract_keywords(prompt_text)

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
            print(f"Processing document: {file_path}")
            extension = Path(file_path).suffix.lower()
            source_for_processing = file_path
            cleanup_pdf: str | None = None

            if extension in {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf"}:
                source_for_processing = self._convert_office_to_pdf(file_path)
                cleanup_pdf = source_for_processing
                print(f"Converted to PDF: {source_for_processing}")

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

            print("Document processed")
            logger.info(
                "Ingest finished for source path=%s (normalized copy already removed). "
                "If LightRAG logged «duplicate document», повторная вставка чанков не выполнялась — "
                "запросы к /query всё равно используют уже существующий граф.",
                file_path,
            )
            return {"status": "success", "message": "Документ обработан"}
        except Exception as e:
            print(f"Error while processing document: {e}")
            return {"status": "error", "message": str(e)}

    async def query(self, question: str, mode: str = "hybrid") -> str:
        """Запрос к RAG — как у вас в основном коде"""
        if self.rag is None:
            return ""
        if getattr(self.rag, "lightrag", None) is None:
            print("WARNING: LightRAG missing; skipping RAG query")
            return ""

        # We only need retrieved context (Next.js will do final LLM generation).
        qprev = (question or "").replace("\n", " ").strip()
        if len(qprev) > 160:
            qprev = qprev[:160] + "…"
        logger.info("RAG /query mode=%s len=%s preview=%r", mode, len(question or ""), qprev)
        result = await self.rag.aquery(
            question,
            mode=mode,
            enable_rerank=False,
            top_k=20,
            only_need_context=True,
        )
        print(f"Query raw result type: {type(result)}")
        if result is None:
            return ""
        if isinstance(result, str):
            return result
        if isinstance(result, dict):
            if "answer" in result and isinstance(result["answer"], str):
                return result["answer"]
            # Fallback: represent dict in a stable way
            return str(result)
        return str(result)

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