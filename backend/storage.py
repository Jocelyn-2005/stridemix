import json
import re
import shutil
import uuid
from pathlib import Path

from backend.audio import SAMPLE_RATE, audio_frame_count, normalize_audio, waveform_peaks
from backend.models import Track

ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class MediaLibrary:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.tracks_dir = self.root / "tracks"
        self.exports_dir = self.root / "exports"
        self.tones_dir = self.root / "tones"
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
            normalize_audio(source_path, audio_path)
            track = Track(
                id=track_id,
                title=title.strip()[:300] or "未命名音乐",
                duration=audio_frame_count(audio_path) / SAMPLE_RATE,
                source=source,
                preview_url=f"/api/media/{track_id}",
                waveform=waveform_peaks(audio_path),
            )
            metadata = directory / "metadata.json"
            temporary = metadata.with_suffix(".tmp")
            temporary.write_text(track.model_dump_json(), encoding="utf-8")
            temporary.replace(metadata)
            return track
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise
