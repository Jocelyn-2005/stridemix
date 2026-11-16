"""Local HTTP API and production frontend for StrideMix."""

import io
import os
import tempfile
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from backend.audio import TONES, AudioError, ffmpeg_executable, write_tone
from backend.jobs import ExportManager
from backend.models import AdaptRequest, ExportRequest, GenerationRequest, ManualTempoRequest, SearchRequest, Track, UrlRequest
from backend.rhythm import rhythm_window
from backend.sources import download_video, generate_music, search_music
from backend.storage import MediaBusyError, MediaLibrary, PROCESSING_LIMIT

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


class MediaFileResponse(FileResponse):
    def __init__(self, path: Path, release, **kwargs):
        super().__init__(path, **kwargs)
        self.release = release

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.release()


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
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @application.exception_handler(AudioError)
    async def audio_error_handler(request, exc: AudioError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @application.exception_handler(MediaBusyError)
    async def media_busy_handler(request, exc: MediaBusyError):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

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

    @application.get("/api/tracks/{track_id}", response_model=Track)
    def track(track_id: str):
        try:
            return library.get(track_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请重新导入") from exc

    @application.get("/api/tracks/{track_id}/deletion")
    def deletion_preview(track_id: str):
        try:
            selected = library.deletion_preview(track_id)
            return {"track_ids": [track.id for track in selected], "titles": [track.title for track in selected]}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请刷新曲库") from exc

    @application.delete("/api/tracks/{track_id}")
    def delete_track(track_id: str, expected_ids: list[str] | None = Body(default=None, embed=True)):
        try:
            return {"deleted_ids": library.delete(track_id, expected_ids)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请刷新曲库") from exc

    @application.post("/api/tracks/{track_id}/analyze", response_model=Track)
    def analyze_track(track_id: str):
        try:
            return library.analyze(track_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请重新导入") from exc

    @application.patch("/api/tracks/{track_id}/tempo", response_model=Track)
    def manual_tempo(track_id: str, request: ManualTempoRequest):
        try:
            return library.set_manual_tempo(track_id, request.bpm)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请重新导入") from exc

    @application.post("/api/tracks/{track_id}/reanalyze", response_model=Track)
    def reanalyze_track(track_id: str):
        try:
            return library.analyze(track_id, force=True)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请重新导入") from exc

    @application.get("/api/tracks/{track_id}/rhythm")
    def track_rhythm(
        track_id: str,
        start_seconds: float = Query(default=0, ge=0),
        duration_seconds: float = Query(default=12, gt=0, le=30),
    ):
        try:
            with library.use_tracks([track_id]), PROCESSING_LIMIT:
                current = library.get(track_id)
                return rhythm_window(
                    library.track_path(track_id), start_seconds, duration_seconds, current.tempo.bpm,
                )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请重新导入") from exc

    @application.post("/api/tracks/{track_id}/adapt", response_model=Track)
    def adapt_track(track_id: str, request: AdaptRequest):
        try:
            return library.adapt(track_id, request.cadence, request.reference_cadence)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="原始素材不存在，请重新导入") from exc

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
            release = library.acquire_tracks([track_id])
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请重新导入") from exc
        try:
            return MediaFileResponse(library.track_path(track_id), release, media_type="audio/wav")
        except Exception:
            release()
            raise

    @application.get("/api/media/{track_id}/chunk")
    def media_chunk(
        track_id: str,
        start_frame: int = Query(default=0, ge=0),
        frame_count: int = Query(default=220500, ge=1, le=441000),
    ):
        try:
            with library.use_tracks([track_id]):
                with wave.open(str(library.track_path(track_id)), "rb") as stream:
                    if start_frame >= stream.getnframes():
                        raise HTTPException(status_code=416, detail="请求片段超出音频长度")
                    stream.setpos(start_frame)
                    samples = stream.readframes(frame_count)
                    channels, sample_width, sample_rate = stream.getnchannels(), stream.getsampwidth(), stream.getframerate()
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="素材不存在，请重新导入") from exc
        output = io.BytesIO()
        with wave.open(output, "wb") as stream:
            stream.setnchannels(channels)
            stream.setsampwidth(sample_width)
            stream.setframerate(sample_rate)
            stream.writeframes(samples)
        return Response(output.getvalue(), media_type="audio/wav")

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
