from contextlib import asynccontextmanager
from pathlib import Path
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from alembic import command
from alembic.config import Config
from app.api.routes import auth, destinations, recommendations, sources, admin
from app.core.config import settings
from app.db import SessionLocal
from app import models  # noqa: F401 - ensures all SQLAlchemy models are registered
from app.seed import seed_destinations
from app.services.destination_import import read_destination_file, upsert_destinations

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("on-the-road-bulgaria")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.app_env.lower() == "production" and settings.jwt_secret_key.startswith("replace-this"):
        raise RuntimeError("Set JWT_SECRET_KEY to a secure random value before production deployment")
    project_root = Path(__file__).resolve().parents[1]
    alembic_config = Config(str(project_root / "alembic.ini"))
    command.upgrade(alembic_config, "head")
    settings.upload_dir.resolve().mkdir(parents=True, exist_ok=True)
    with SessionLocal() as db:
        data_dir = project_root / "app" / "data" / "destinations"
        json_path = data_dir / "destinations.json"
        if not json_path.is_file():
            # Keep the original single-file location working for existing installs.
            json_path = project_root / "app" / "data" / "destinations.json"
        imported = 0
        if json_path.is_file():
            records = read_destination_file(json_path)
            if records:
                created, updated = upsert_destinations(db, records)
                imported = created + updated
                logger.info("Imported %s destinations from %s (%s created, %s updated).", imported, json_path, created, updated)
        seeded = seed_destinations(db)
        if seeded:
            logger.info("Loaded %s missing demonstration destinations; they remain marked unverified.", seeded)
    yield


def create_app(*, initialize_database: bool = True) -> FastAPI:
    app = FastAPI(
        title="On the Road Bulgaria API",
        description="Travel planning and a traceable OCR corpus for Bulgarian historical sources. Travel estimates and OCR text require independent verification.",
        version="0.2.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        lifespan=lifespan if initialize_database else None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.include_router(auth.router)
    app.include_router(destinations.router)
    app.include_router(destinations.admin_router)
    app.include_router(recommendations.router)
    app.include_router(sources.router)
    app.include_router(sources.admin_router)
    app.include_router(admin.router)

    @app.get("/api/config", tags=["system"])
    def public_config():
        # Only the referrer-restricted browser key is public. Never expose the Routes API key.
        return {
            "google_maps_js_api_key": settings.google_maps_js_api_key or None,
            "google_routes_enabled": bool(settings.google_routes_api_key),
            "map_provider": "google_maps",
            "google_maps_enabled": bool(settings.google_maps_js_api_key),
        }

    @app.get("/api/health", tags=["system"])
    def health():
        return {"status": "ok", "app": settings.app_name, "environment": settings.app_env}

    static_dir = Path(__file__).parent / "static2"
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.get("/", include_in_schema=False)
    def home():
        return FileResponse(static_dir / "index.html", headers={"Cache-Control": "no-store"})

    # Serve the same relative asset paths used by the GitHub Pages build.
    # Keeping these aliases means the frontend behaves identically in the
    # FastAPI deployment and when the contents of static2 are published alone.
    for asset_name in ("styles.css", "app.js", "bulgaria.geojson", "logo.png", "logo_without_text.png"):
        app.add_api_route(f"/{asset_name}", lambda asset_name=asset_name: FileResponse(static_dir / asset_name), include_in_schema=False)

    return app


app = create_app()
