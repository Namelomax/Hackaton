import asyncio
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import aiofiles

from rag_service import RAGService, BASE_URL, EMBEDDING_MODEL

logger = logging.getLogger(__name__)

# Модели данных для API
class QueryRequest(BaseModel):
    question: str
    mode: Optional[str] = Field(default="hybrid", description="Режим поиска: hybrid, local, global")

class QueryResponse(BaseModel):
    answer: str
    status: str = "success"

class DocumentResponse(BaseModel):
    message: str
    filename: str
    status: str


class IndexedDocumentItem(BaseModel):
    id: str
    filename: str
    status: str = ""


class DeleteDocumentResponse(BaseModel):
    ok: bool
    error: Optional[str] = None

# Жизненный цикл приложения
rag_service = RAGService()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Запуск: инициализация RAG
    print("RAG service initialization...")
    await rag_service.initialize()
    print("RAG service ready")
    yield
    # Завершение: очистка
    print("RAG service shutdown...")
    await rag_service.cleanup()
    print("RAG service stopped")

app = FastAPI(
    title="RAG API Service",
    description="API для обработки документов и запросов к RAG системе",
    version="1.0.0",
    lifespan=lifespan
)

CORS_ORIGINS = os.getenv("RAG_CORS_ORIGINS", "http://localhost:3000").split(",")

# CORS для React приложения
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in CORS_ORIGINS if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Создаём папки если их нет
os.makedirs("uploads", exist_ok=True)
os.makedirs("output", exist_ok=True)

@app.get("/")
async def root():
    return {"message": "RAG API Service is running", "status": "ok"}

@app.post("/upload", response_model=DocumentResponse)
async def upload_document(
    file: UploadFile = File(...),
    wait: bool = Query(
        False,
        description="Дождаться окончания индексации (для внутренних вызовов из Next.js).",
    ),
):
    """
    Загрузка документа для обработки.
    Поддерживаемые форматы: .doc/.docx, .xls/.xlsx, .ppt/.pptx, .pdf, .txt, .md, .rtf

    По умолчанию ответ сразу status=queued, индексация в фоне.
    С wait=true HTTP-ответ после завершения ingest (дольше, но клиент не отправит чат раньше времени).
    """
    # Проверка расширения
    allowed_extensions = {
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".pdf",
        ".txt",
        ".md",
        ".rtf",
    }
    file_ext = os.path.splitext(file.filename)[1].lower()
    
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Неподдерживаемый формат. Разрешены: {allowed_extensions}"
        )

    # Сохраняем файл
    unique_filename = f"{uuid.uuid4()}_{file.filename}"
    file_path = os.path.join("uploads", unique_filename)
    
    async with aiofiles.open(file_path, "wb") as out_file:
        content = await file.read()
        await out_file.write(content)

    async def process_in_background(path_to_process: str):
        try:
            result = await rag_service.process_document(path_to_process)
            if result.get("status") == "error":
                print(f"[upload background] failed for {path_to_process}: {result.get('message')}")
            else:
                print(f"[upload background] success for {path_to_process}")
        except Exception as background_error:
            print(f"[upload background] exception for {path_to_process}: {background_error}")
        finally:
            # Очистка временного файла после фоновой обработки
            if os.path.exists(path_to_process):
                os.remove(path_to_process)

    if wait:
        try:
            result = await rag_service.process_document(file_path)
            if result.get("status") == "error":
                raise HTTPException(
                    status_code=500,
                    detail=str(result.get("message") or "RAG processing failed"),
                )
            logger.info(
                "POST /upload wait=true done: client_filename=%r status=%s message=%r",
                file.filename,
                result.get("status"),
                result.get("message"),
            )
            return DocumentResponse(
                message=f"Документ {file.filename} проиндексирован",
                filename=file.filename,
                status="indexed",
            )
        finally:
            if os.path.exists(file_path):
                os.remove(file_path)

    asyncio.create_task(process_in_background(file_path))

    return DocumentResponse(
        message=f"Документ {file.filename} принят в обработку",
        filename=file.filename,
        status="queued",
    )

@app.get("/documents", response_model=list[IndexedDocumentItem])
@app.get("/indexed-documents", response_model=list[IndexedDocumentItem])
async def list_indexed_documents():
    """Документы, присутствующие в индексе LightRAG.

    Два пути: /documents и /indexed-documents — на случай прокси/старых образов, где один из путей отдаёт 404.
    """
    try:
        items = rag_service.list_indexed_documents()
        return [IndexedDocumentItem(**x) for x in items]
    except Exception as e:
        logger.exception("RAG list indexed documents failed")
        raise HTTPException(status_code=500, detail=str(e))


class DeleteByIdBody(BaseModel):
    id: str


@app.delete("/documents", response_model=DeleteDocumentResponse)
@app.delete("/indexed-documents", response_model=DeleteDocumentResponse)
async def delete_indexed_document(body: DeleteByIdBody = Body(...)):
    """Удалить документ из индекса по id (как в списке /documents или /indexed-documents)."""
    doc_id = (body.id or "").strip()
    if not doc_id:
        raise HTTPException(status_code=400, detail="id required")
    result = await rag_service.delete_indexed_document(doc_id)
    if not result.get("ok"):
        raise HTTPException(
            status_code=400,
            detail=str(result.get("error") or "delete failed"),
        )
    return DeleteDocumentResponse(ok=True)


@app.post("/prune-failed")
async def prune_failed_documents():
    """Удалить из индекса все записи со статусом FAILED и dup-* (хвосты повторных загрузок)."""
    try:
        result = await rag_service.prune_failed_documents()
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail=str(result.get("error") or "prune failed"))
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("RAG prune-failed failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/query", response_model=QueryResponse)
async def query_rag(request: QueryRequest):
    """
    Запрос к RAG системе
    """
    try:
        answer = await rag_service.query(request.question, request.mode)
        return QueryResponse(answer=answer)
    except Exception as e:
        logger.exception("RAG /query failed")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    """Проверка работоспособности и подсказка по URL эмбеддингов (без секретов)."""
    low = (BASE_URL or "").lower()
    return {
        "status": "healthy",
        "embedding_openai_base_url": BASE_URL,
        "embedding_model": EMBEDDING_MODEL,
        "embedding_url_looks_localhost": "127.0.0.1" in low or "localhost" in low,
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    )