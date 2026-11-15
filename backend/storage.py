import json
import re
import shutil
import threading
import uuid
from pathlib import Path

from backend.audio import SAMPLE_RATE, AudioError, audio_frame_count, normalize_audio, waveform_peaks
from backend.models import Adaptation, Tempo, Track
from backend.tempo import analyze_tempo, cadence_references, change_tempo

ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
PROCESSING_LIMIT = threading.BoundedSemaphore(2)


class MediaLibrary:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.tracks_dir = self.root / "tracks"
        self.exports_dir = self.root / "exports"
        self.tones_dir = self.root / "tones"
        self.metadata_lock = threading.RLock()
        for directory in (self.tracks_dir, self.exports_dir, self.tones_dir):
            directory.mkdir(parents=True, exist_ok=True)

    def track_path(self, track_id: str) -> Path:
        if not ID_PATTERN.fullmatch(track_id):
            raise KeyError(track_id)
        target = self.tracks_dir / track_id / "audio.wav"
        if not target.is_file():
            raise KeyError(track_id)
        return target

    def get(self, track_id: str) -> Track:
        self.track_path(track_id)
        try:
            with self.metadata_lock:
                data = json.loads((self.tracks_dir / track_id / "metadata.json").read_text(encoding="utf-8"))
            track = Track.model_validate(data)
            if track.id != track_id:
                raise ValueError("Metadata ID mismatch")
            return track
        except (OSError, ValueError) as exc:
            raise KeyError(track_id) from exc

    def list(self) -> list[Track]:
        tracks = []
        for directory in sorted(self.tracks_dir.iterdir(), key=lambda item: item.name):
            if directory.is_dir() and ID_PATTERN.fullmatch(directory.name):
                try:
                    tracks.append(self.get(directory.name))
                except KeyError:
                    continue
        return tracks

    def import_file(self, source_path: Path, title: str, source: str) -> Track:
        track_id = uuid.uuid4().hex
        directory = self.tracks_dir / track_id
        directory.mkdir()
        try:
            audio_path = directory / "audio.wav"
            with PROCESSING_LIMIT:
                normalize_audio(source_path, audio_path)
                tempo = analyze_tempo(audio_path)
                return self._finish_track(track_id, title, source, tempo)
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise

    def _save(self, track: Track) -> Track:
        metadata = self.tracks_dir / track.id / "metadata.json"
        temporary = metadata.with_name(f"metadata.{uuid.uuid4().hex}.tmp")
        with self.metadata_lock:
            try:
                temporary.write_text(track.model_dump_json(), encoding="utf-8")
                temporary.replace(metadata)
            finally:
                temporary.unlink(missing_ok=True)
        return track

    def _finish_track(
        self, track_id: str, title: str, source: str, tempo: Tempo,
        adaptation: Adaptation | None = None,
    ) -> Track:
        audio_path = self.track_path(track_id)
        track = Track(
            id=track_id, title=title.strip()[:300] or "未命名音乐",
            duration=audio_frame_count(audio_path) / SAMPLE_RATE,
            source=source, preview_url=f"/api/media/{track_id}",
            waveform=waveform_peaks(audio_path), tempo=tempo, adaptation=adaptation,
        )
        return self._save(track)

    def analyze(self, track_id: str) -> Track:
        current = self.get(track_id)
        if current.tempo.status != "pending":
            return current
        with PROCESSING_LIMIT:
            current = self.get(track_id)
            if current.tempo.status != "pending":
                return current
            result = analyze_tempo(self.track_path(track_id))
            with self.metadata_lock:
                current = self.get(track_id)
                # A manual correction made while analysis runs takes precedence.
                if current.tempo.status == "pending":
                    current = current.model_copy(update={"tempo": result})
                    self._save(current)
                return current

    def set_manual_tempo(self, track_id: str, bpm: float) -> Track:
        with self.metadata_lock:
            current = self.get(track_id)
            tempo = Tempo(bpm=bpm, confidence=1, status="detected", source="manual")
            return self._save(current.model_copy(update={"tempo": tempo}))

    def adapt(self, track_id: str, cadence: float, reference_cadence: float) -> Track:
        current = self.analyze(track_id)
        if current.tempo.bpm is None:
            raise AudioError("无法可靠估算此音乐的节奏，请先手动输入 BPM")
        candidates = cadence_references(current.tempo.bpm)
        reference = min(candidates, key=lambda value: abs(value - reference_cadence))
        if abs(reference - reference_cadence) > 0.11:
            raise AudioError("参考步频必须对应当前 BPM 的半拍、原拍或双拍")
        local_speed = cadence / reference
        original_id = current.adaptation.original_id if current.adaptation else current.id
        previous_speed = current.adaptation.speed if current.adaptation else 1
        total_speed = previous_speed * local_speed
        original_audio = self.track_path(original_id)
        track_id = uuid.uuid4().hex
        directory = self.tracks_dir / track_id
        directory.mkdir()
        try:
            with PROCESSING_LIMIT:
                # Always render from the first source rather than stretching an
                # already processed file a second time.
                change_tempo(original_audio, directory / "audio.wav", total_speed)
                adapted_tempo = Tempo(
                    bpm=round(current.tempo.bpm * local_speed, 4),
                    confidence=current.tempo.confidence,
                    status=current.tempo.status, source="adapted",
                )
                adaptation = Adaptation(
                    original_id=original_id, speed=total_speed,
                    reference_cadence=reference, target_cadence=cadence,
                )
                original_title = self.get(original_id).title
                title = f"{original_title} · {cadence:g} 步/分"
                return self._finish_track(track_id, title, current.source, adapted_tempo, adaptation)
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise
