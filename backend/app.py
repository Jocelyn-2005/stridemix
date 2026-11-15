"""Local HTTP API and production frontend for StrideMix."""

import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from backend.audio import TONES, AudioError, ffmpeg_executable, write_tone
from backend.jobs import ExportManager
from backend.models import ExportRequest, GenerationRequest, SearchRequest, Track, UrlRequest
from backend.sources import download_video, generate_music, search_music
from backend.storage import MediaLibrary

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def create_app(data_dir: Path | None = None) -> FastAPI:
    library = MediaLibrary(data_dir or Path(os.environ.get("STRIDEMIX_DATA_DIR", ROOT / "data")))
    temporary_root = library.root / "tmp"
    temporary_root.mkdir(exist_ok=True)
    jobs = ExportManager(library)
    for tone in TONES:
        write_tone(library.tones_dir / f"{tone['id']}.wav", tone["id"])

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        yield
        await run_in_threadpool(jobs.shutdown)

    application = FastAPI(title="StrideMix", version="0.1.0", lifespan=lifespan)
    application.state.library = library
    application.state.jobs = jobs
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @application.exception_handler(AudioError)
    async def audio_error_handler(request, exc: AudioError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @application.get("/api/health")
    def health():
        try:
            ffmpeg_ready = Path(ffmpeg_executable()).is_file()
        except Exception:
            ffmpeg_ready = False
        return {
            "status": "ok" if ffmpeg_ready else "degraded",
            "ffmpeg": ffmpeg_ready,
            "ai_configured": bool(os.environ.get("ELEVENLABS_API_KEY", "").strip()),
        }

    @application.get("/api/tones")
    def tones():
        return TONES

    @application.get("/api/tones/{tone_id}.wav")
    def tone_audio(tone_id: str):
        if tone_id not in {tone["id"] for tone in TONES}:
            raise HTTPException(status_code=404, detail="音色不存在")
        return FileResponse(library.tones_dir / f"{tone_id}.wav", media_type="audio/wav")

    @application.get("/api/tracks", response_model=list[Track])
    def tracks():
        return library.list()

    @application.post("/api/tracks/upload", response_model=Track)
    async def upload_track(file: UploadFile = File(...)):
        try:
            with tempfile.TemporaryDirectory(dir=temporary_root) as temporary:
                source = Path(temporary) / "upload.bin"
                with source.open("wb") as output:
                    while chunk := await file.read(1024 * 1024):
                        output.write(chunk)
                title = Path((file.filename or "未命名音乐").replace("\\", "/")).stem
                return await run_in_threadpool(library.import_file, source, title, "本地文件")
        finally:
            await file.close()

    @application.post("/api/search")
    def search(request: SearchRequest):
        return {"results": search_music(request.query)}

    @application.post("/api/tracks/url", response_model=Track)
    def import_url(request: UrlRequest):
        with tempfile.TemporaryDirectory(dir=temporary_root) as temporary:
            downloaded, title = download_video(request.url, Path(temporary))
            return library.import_file(downloaded, title, urlparse(request.url).hostname or "视频链接")

    @application.post("/api/tracks/generate", response_model=Track)
    def generate(request: GenerationRequest):
        with tempfile.TemporaryDirectory(dir=temporary_root) as temporary:
            source = Path(temporary) / "generated.mp3"
            generate_music(request.prompt, request.duration, source)
            return library.import_file(source, request.prompt[:60], "AI · ElevenLabs")

    @application.get("/api/media/{track_id}")
    def media(track_id: str):
        try:
            path = library.track_path(track_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请重新导入") from exc
        return FileResponse(path, media_type="audio/wav")

    @application.post("/api/exports")
    def start_export(request: ExportRequest):
        try:
            return jobs.create(request)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="有音乐素材已丢失，请重新导入") from exc

    @application.get("/api/exports/{job_id}")
    def export_status(job_id: str):
        try:
            return jobs.get(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="导出任务不存在或应用已重启") from exc

    @application.delete("/api/exports/{job_id}")
    def cancel_export(job_id: str):
        try:
            return jobs.cancel(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="导出任务不存在") from exc

    @application.get("/api/exports/{job_id}/download")
    def download_export(job_id: str):
        try:
            path = jobs.output_path(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="导出文件不存在") from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        media_type = "audio/mpeg" if path.suffix == ".mp3" else "audio/wav"
        return FileResponse(path, media_type=media_type, filename=f"StrideMix-{job_id[:8]}{path.suffix}")

    @application.get("/{requested_path:path}", include_in_schema=False)
    def frontend(requested_path: str):
        if requested_path == "api" or requested_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API 不存在")
        frontend_root = (ROOT / "frontend" / "dist").resolve()
        target = (frontend_root / requested_path).resolve()
        if not target.is_relative_to(frontend_root):
            raise HTTPException(status_code=404, detail="文件不存在")
        if target.is_file():
            return FileResponse(target)
        index = frontend_root / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(status_code=503, detail="网页尚未构建，请在 frontend 目录执行 npm install 和 npm run build")

    return application


app = create_app()
