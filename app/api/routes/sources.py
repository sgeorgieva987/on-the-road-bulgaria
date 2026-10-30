from datetime import datetime, timezone
from pathlib import Path
import io
import uuid
import fitz
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session
from sqlalchemy import or_
from app.core.config import settings
from app.db import get_db
from app.dependencies import get_current_user, get_optional_user, require_admin
from app.models import BookSource, Destination, SourcePage, SourceReference, TextPassage, User
from app.schemas import PageDestinationLinkRequest, ReviewTextRequest, SearchResult, SourceOut, SourcePageOut, SourceReferenceStatusUpdate
from app.services.ocr import create_passages
from app.services.background_jobs import run_ocr_job
from app.api.routes.destinations import _search_terms

router = APIRouter(prefix="/api", tags=["historical sources and OCR"])
admin_router = APIRouter(prefix="/api/admin", tags=["administration"])
ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"}
PUBLIC_COPYRIGHT_STATUS = {"public_domain", "licensed", "permission_granted"}


def _validate_upload(data: bytes, extension: str) -> None:
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty")
    if extension == ".pdf":
        if not data.startswith(b"%PDF-"):
            raise HTTPException(status_code=415, detail="The file extension says PDF, but the file signature is not PDF")
        try:
            pdf = fitz.open(stream=data, filetype="pdf")
            page_count = pdf.page_count
            oversized_page = any((page.rect.width * 2) * (page.rect.height * 2) > 40_000_000 for page in pdf)
            pdf.close()
        except Exception:
            raise HTTPException(status_code=415, detail="The PDF file could not be opened")
        if page_count < 1 or page_count > settings.max_pdf_pages:
            raise HTTPException(status_code=413, detail=f"PDF must contain 1–{settings.max_pdf_pages} pages")
        if oversized_page:
            raise HTTPException(status_code=413, detail="A PDF page is too large to render safely at the configured OCR resolution")
    else:
        try:
            with Image.open(io.BytesIO(data)) as img:
                if img.width * img.height > 40_000_000:
                    raise HTTPException(status_code=413, detail="Image dimensions exceed the 40-megapixel processing limit")
                img.verify()
        except (UnidentifiedImageError, OSError, ValueError):
            raise HTTPException(status_code=415, detail="Unsupported or invalid image file")


@admin_router.post("/sources", response_model=SourceOut, status_code=201)
async def upload_source(
    title: str = Form(min_length=2, max_length=320),
    file: UploadFile = File(...),
    author: str | None = Form(default=None, max_length=320),
    publication_year: int | None = Form(default=None, ge=1000, le=2100),
    publisher: str | None = Form(default=None, max_length=320),
    edition: str | None = Form(default=None, max_length=240),
    language: str = Form(default="bg", max_length=12),
    copyright_status: str = Form(default="unknown", pattern="^(unknown|public_domain|licensed|permission_granted|restricted)$"),
    bibliographic_reference: str | None = Form(default=None, max_length=4000),
    source_url: str | None = Form(default=None, max_length=1000),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if source_url and not (source_url.startswith("https://") or source_url.startswith("http://")):
        raise HTTPException(status_code=422, detail="source_url must begin with http:// or https://")
    extension = Path(file.filename or "").suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Allowed file types: {', '.join(sorted(ALLOWED_EXTENSIONS))}")
    data = await file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds {settings.max_upload_mb} MB limit")
    _validate_upload(data, extension)
    storage_dir = settings.upload_dir.resolve() / "sources"
    storage_dir.mkdir(parents=True, exist_ok=True)
    storage_path = storage_dir / f"{uuid.uuid4().hex}{extension}"
    storage_path.write_bytes(data)
    source = BookSource(
        title=title.strip(), author=author, publication_year=publication_year, publisher=publisher,
        edition=edition, language=language.strip().lower(), copyright_status=copyright_status,
        bibliographic_reference=bibliographic_reference, source_url=source_url,
        original_filename=(file.filename or "upload")[:255], storage_path=str(storage_path),
        processing_status="uploaded", created_by_user_id=user.id,
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return source


@admin_router.get("/sources", response_model=list[SourceOut])
def list_admin_sources(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    return db.query(BookSource).order_by(BookSource.created_at.desc()).all()


@admin_router.get("/sources/{source_id}/pages", response_model=list[SourcePageOut])
def list_source_pages(source_id: int, _: User = Depends(require_admin), db: Session = Depends(get_db)):
    if not db.get(BookSource, source_id):
        raise HTTPException(status_code=404, detail="Source not found")
    return db.query(SourcePage).filter_by(source_id=source_id).order_by(SourcePage.page_number).all()


@admin_router.post("/sources/{source_id}/process-ocr", status_code=202)
def process_ocr(source_id: int, background_tasks: BackgroundTasks, _: User = Depends(require_admin), db: Session = Depends(get_db)):
    source = db.get(BookSource, source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    if source.processing_status in {"queued", "processing"}:
        raise HTTPException(status_code=409, detail="OCR processing is already running for this source")
    source.processing_status = "queued"
    db.commit()
    background_tasks.add_task(run_ocr_job, source_id, False)
    return {"source_id": source_id, "status": "queued", "message": "OCR job queued; poll the source status endpoint for page-level progress."}


@admin_router.post("/sources/{source_id}/retry-failed", status_code=202)
def retry_failed_pages(source_id: int, background_tasks: BackgroundTasks, _: User = Depends(require_admin), db: Session = Depends(get_db)):
    source = db.get(BookSource, source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    if source.processing_status in {"queued", "processing"}:
        raise HTTPException(status_code=409, detail="OCR processing is already running for this source")
    source.processing_status = "queued"
    db.commit()
    background_tasks.add_task(run_ocr_job, source_id, True)
    return {"source_id": source_id, "status": "queued", "message": "Failed pages queued for retry."}


@admin_router.get("/sources/{source_id}/status")
def source_processing_status(source_id: int, _: User = Depends(require_admin), db: Session = Depends(get_db)):
    source = db.get(BookSource, source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    pages = db.query(SourcePage).filter_by(source_id=source_id).all()
    counts = {"completed": 0, "failed": 0, "processing": 0, "pending": 0}
    for page in pages:
        counts[page.processing_status] = counts.get(page.processing_status, 0) + 1
    return {"source_id": source_id, "status": source.processing_status, "page_count": len(pages), "counts": counts}


@admin_router.get("/pages/{page_id}/image")
def view_source_page_image(
    page_id: int,
    variant: str = Query(default="original", pattern="^(original|processed)$"),
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    page = db.get(SourcePage, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    path = page.original_image_path if variant == "original" else page.processed_image_path
    if not path:
        raise HTTPException(status_code=404, detail="Page image not found")
    resolved = Path(path).resolve()
    upload_root = settings.upload_dir.resolve()
    if upload_root not in resolved.parents or not resolved.is_file():
        raise HTTPException(status_code=404, detail="Page image not found")
    return FileResponse(resolved)


@admin_router.post("/pages/{page_id}/review")
def review_source_page(
    page_id: int,
    payload: ReviewTextRequest,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    page = db.get(SourcePage, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    page.normalized_text = payload.normalized_text.strip()
    page.verification_status = payload.verification_status
    page.review_status = "reviewed" if payload.mark_reviewed else "needs_review"
    if payload.mark_reviewed:
        page.reviewer_user_id = user.id
        page.reviewed_at = datetime.now(timezone.utc)
        passage_count = create_passages(db, page, page.normalized_text)
    else:
        passage_count = 0
        db.query(TextPassage).filter_by(source_page_id=page.id).delete(synchronize_session=False)
    db.commit()
    return {"page_id": page.id, "review_status": page.review_status, "verification_status": page.verification_status, "passages_created": passage_count}


@admin_router.post("/pages/{page_id}/link-destination", status_code=201)
def link_page_to_destination(
    page_id: int,
    payload: PageDestinationLinkRequest,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    page = db.get(SourcePage, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    destination = db.get(Destination, payload.destination_id)
    if not destination:
        raise HTTPException(status_code=404, detail="Destination not found")
    source = db.get(BookSource, page.source_id)
    reference = SourceReference(
        destination_id=destination.id,
        source_id=source.id,
        page_number=page.page_number,
        excerpt=(payload.excerpt or page.normalized_text or page.raw_ocr_text or "")[:2000] or None,
        review_status=payload.review_status,
        reviewer_user_id=user.id if payload.review_status == "verified" else None,
    )
    db.add(reference)
    db.commit()
    db.refresh(reference)
    return {"id": reference.id, "destination_id": destination.id, "destination_name": destination.name, "source_id": source.id, "source_title": source.title, "page_number": page.page_number, "review_status": reference.review_status}


@admin_router.patch("/source-references/{reference_id}")
def update_source_reference_status(
    reference_id: int,
    payload: SourceReferenceStatusUpdate,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    reference = db.get(SourceReference, reference_id)
    if not reference:
        raise HTTPException(status_code=404, detail="Source reference not found")
    reference.review_status = payload.review_status
    reference.reviewer_user_id = user.id if payload.review_status == "verified" else None
    db.commit()
    return {"id": reference.id, "review_status": reference.review_status}


@router.get("/destinations/{destination_id}/sources")
def destination_sources(
    destination_id: int,
    user: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    destination = db.get(Destination, destination_id)
    if not destination:
        raise HTTPException(status_code=404, detail="Destination not found")
    is_admin = bool(user and user.is_admin)
    references = db.query(SourceReference).filter_by(destination_id=destination_id).order_by(SourceReference.created_at.desc()).all()
    results = []
    for reference in references:
        source = db.get(BookSource, reference.source_id)
        if source is None:
            continue
        page = db.query(SourcePage).filter_by(source_id=source.id, page_number=reference.page_number).first() if reference.page_number is not None else None
        if not is_admin:
            if reference.review_status != "verified" or source.copyright_status not in PUBLIC_COPYRIGHT_STATUS:
                continue
            if not page or page.review_status != "reviewed" or page.verification_status != "verified":
                continue
        results.append({
            "reference_id": reference.id,
            "source_id": source.id,
            "source_title": source.title,
            "author": source.author,
            "publication_year": source.publication_year,
            "page_number": reference.page_number,
            "excerpt": reference.excerpt,
            "review_status": reference.review_status,
            "copyright_status": source.copyright_status,
            "source_url": source.source_url,
        })
    return results


@router.get("/sources/search", response_model=list[SearchResult])
def search_historical_text(
    q: str,
    limit: int = 20,
    user: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    q = q.strip()
    if len(q) < 2 or len(q) > 160:
        raise HTTPException(status_code=422, detail="Search query must contain 2–160 characters")
    limit = min(max(limit, 1), 50)
    conditions = [TextPassage.text.ilike(f"%{term}%") for term in _search_terms(q)]
    query = db.query(TextPassage, SourcePage, BookSource).join(SourcePage, TextPassage.source_page_id == SourcePage.id).join(BookSource, TextPassage.source_id == BookSource.id).filter(or_(*conditions))
    if not (user and user.is_admin):
        query = query.filter(
            SourcePage.review_status == "reviewed",
            SourcePage.verification_status == "verified",
            BookSource.copyright_status.in_(PUBLIC_COPYRIGHT_STATUS),
        )
    rows = query.order_by(BookSource.title, SourcePage.page_number).limit(limit).all()
    result = []
    for passage, page, source in rows:
        text = passage.text
        index = text.casefold().find(q.casefold())
        start = max(0, index - 160) if index >= 0 else 0
        excerpt = text[start:start + 500]
        if start > 0:
            excerpt = "…" + excerpt
        if start + 500 < len(text):
            excerpt += "…"
        result.append(SearchResult(
            source_id=source.id,
            source_title=source.title,
            author=source.author,
            publication_year=source.publication_year,
            page_id=page.id,
            page_number=page.page_number,
            passage=excerpt,
            review_status=page.review_status,
            verification_status=page.verification_status,
            copyright_status=source.copyright_status,
            source_url=source.source_url,
            bibliographic_reference=source.bibliographic_reference,
        ))
    return result
