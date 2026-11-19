import json
import re
import shutil
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from backend.alignment import analyze_alignment
from backend.adaptive import measure_segments, plan_segments, render_segments
from backend.audio import SAMPLE_RATE, AudioError, audio_frame_count, normalize_audio, waveform_peaks
from backend.models import Adaptation, Alignment, Tempo, Track
from backend.tempo import analyze_tempo, cadence_references, change_tempo

ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
PROCESSING_LIMIT = threading.BoundedSemaphore(2)


class MediaBusyError(Exception):
    pass


class MediaLibrary:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.tracks_dir = self.root / "tracks"
        self.exports_dir = self.root / "exports"
        self.tones_dir = self.root / "tones"
        self.metadata_lock = threading.RLock()
        self.media_uses: dict[str, int] = {}
        for directory in (self.tracks_dir, self.exports_dir, self.tones_dir):
            directory.mkdir(parents=True, exist_ok=True)
        # Retry cleanup after external file handles delayed an earlier deletion.
        for directory in self.tracks_dir.glob(".deleted-*"):
            identifier = directory.name.removeprefix(".deleted-")
            if ID_PATTERN.fullmatch(identifier) and not directory.is_symlink() and directory.resolve().parent == self.tracks_dir:
                shutil.rmtree(directory, ignore_errors=True)

    def track_path(self, track_id: str) -> Path:
        if not ID_PATTERN.fullmatch(track_id):
            raise KeyError(track_id)
        target = self.tracks_dir / track_id / "audio.wav"
        if (
            not target.is_file()
            or target.parent.resolve() != target.parent
            or target.resolve().parent != target.parent
            or not target.resolve().is_relative_to(self.root)
        ):
            raise KeyError(track_id)
        return target

    def acquire_tracks(self, track_ids: list[str]) -> Callable[[], None]:
        identifiers = set(track_ids)
        with self.metadata_lock:
            for track_id in identifiers:
                self.track_path(track_id)
            for track_id in identifiers:
                self.media_uses[track_id] = self.media_uses.get(track_id, 0) + 1
        released = False

        def release() -> None:
            nonlocal released
            with self.metadata_lock:
                if released:
                    return
                released = True
                for track_id in identifiers:
                    remaining = self.media_uses[track_id] - 1
                    if remaining:
                        self.media_uses[track_id] = remaining
                    else:
                        del self.media_uses[track_id]

        return release

    @contextmanager
    def use_tracks(self, track_ids: list[str]) -> Iterator[None]:
        release = self.acquire_tracks(track_ids)
        try:
            yield
        finally:
            release()

    def deletion_preview(self, track_id: str) -> list[Track]:
        with self.metadata_lock:
            selected = self.get(track_id)
            if selected.adaptation:
                return [selected]
            selected_ids = {selected.id}
            tracks = self.list()
            for track in tracks:
                if track.adaptation and track.adaptation.original_id in selected_ids:
                    selected_ids.add(track.id)
            return [selected, *(track for track in tracks if track.id in selected_ids and track.id != selected.id)]

    def delete(self, track_id: str, expected_ids: list[str] | None = None) -> list[str]:
        if not ID_PATTERN.fullmatch(track_id):
            raise KeyError(track_id)
        moved: list[tuple[Path, Path]] = []
        with self.metadata_lock:
            if not (self.tracks_dir / track_id).exists():
                return []
            tracks = self.deletion_preview(track_id)
            track_ids = [track.id for track in tracks]
            if expected_ids is not None and set(expected_ids) != set(track_ids):
                raise MediaBusyError("素材的关联版本已变化，请重新确认删除范围。")
            if any(self.media_uses.get(identifier, 0) for identifier in track_ids):
                raise MediaBusyError("素材正在分析、制作、导出或读取，请等待任务结束或停止试听后再删除。")
            try:
                for identifier in track_ids:
                    source = self.track_path(identifier).parent
                    destination = self.tracks_dir / f".deleted-{uuid.uuid4().hex}"
                    source.rename(destination)
                    moved.append((source, destination))
            except OSError as error:
                for source, destination in reversed(moved):
                    destination.rename(source)
                raise MediaBusyError("素材文件正在被使用，删除未完成，请停止试听后重试。") from error
        # Once all folders have moved, the whole family is absent from the library.
        # Failed disk cleanup remains hidden and can be retried without reviving it.
        for _, destination in moved:
            shutil.rmtree(destination, ignore_errors=True)
        return track_ids

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
        alignment = analyze_alignment(audio_path, tempo.bpm)
        tempo = self._refine_tempo(tempo, alignment)
        track = Track(
            id=track_id, title=title.strip()[:300] or "未命名音乐",
            duration=audio_frame_count(audio_path) / SAMPLE_RATE,
            source=source, preview_url=f"/api/media/{track_id}",
            waveform=waveform_peaks(audio_path), tempo=tempo, adaptation=adaptation, alignment=alignment,
        )
        return self._save(track)

    @staticmethod
    def _refine_tempo(tempo: Tempo, alignment: Alignment, include_adapted: bool = False) -> Tempo:
        # Sparse percussion can leave phase uncertain while its period still
        # supports a small precision correction. Keep both confidence labels.
        if (
            (tempo.source == "analysis" or (include_adapted and tempo.source == "adapted"))
            and tempo.bpm is not None and alignment.bpm is not None and alignment.anchor_seconds is not None
            and alignment.confidence >= 0.1 and alignment.drift_ms is not None and alignment.drift_ms <= 20
            and abs(alignment.bpm / tempo.bpm - 1) <= 0.002
        ):
            return tempo.model_copy(update={"bpm": alignment.bpm})
        return tempo

    def analyze(self, track_id: str, force: bool = False) -> Track:
        with self.use_tracks([track_id]):
            current = self.get(track_id)
            if not force and current.tempo.status != "pending" and current.alignment.status != "pending":
                return current
            with PROCESSING_LIMIT:
                current = self.get(track_id)
                if not force and current.tempo.status != "pending" and current.alignment.status != "pending":
                    return current
                snapshot = current
                path = self.track_path(track_id)
                tempo = analyze_tempo(path) if force or snapshot.tempo.status == "pending" else snapshot.tempo
                alignment = analyze_alignment(path, tempo.bpm)
                tempo = self._refine_tempo(tempo, alignment)
                with self.metadata_lock:
                    current = self.get(track_id)
                    # A manual correction made while analysis runs takes precedence.
                    if current.tempo == snapshot.tempo and current.alignment == snapshot.alignment:
                        current = current.model_copy(update={"tempo": tempo, "alignment": alignment})
                        self._save(current)
                    return current

    def set_manual_tempo(self, track_id: str, bpm: float) -> Track:
        with self.use_tracks([track_id]):
            with self.metadata_lock:
                current = self.get(track_id)
                tempo = Tempo(bpm=bpm, confidence=1, status="detected", source="manual")
                self._save(current.model_copy(update={"tempo": tempo, "alignment": Alignment()}))
            with PROCESSING_LIMIT:
                alignment = analyze_alignment(self.track_path(track_id), bpm)
            with self.metadata_lock:
                current = self.get(track_id)
                if current.tempo == tempo:
                    current = self._save(current.model_copy(update={"alignment": alignment}))
                return current

    def adapt(self, track_id: str, cadence: float, reference_cadence: float) -> Track:
        with self.metadata_lock:
            requested = self.get(track_id)
            original_id = requested.adaptation.original_id if requested.adaptation else requested.id
            release = self.acquire_tracks([track_id, original_id])
        try:
            current = self.analyze(track_id)
            if current.tempo.bpm is None:
                raise AudioError("无法可靠估算此音乐的节奏，请先手动输入 BPM")
            reference_bpm = requested.tempo.bpm or current.tempo.bpm
            candidates = cadence_references(reference_bpm)
            reference = min(candidates, key=lambda value: abs(value - reference_cadence))
            if abs(reference - reference_cadence) > 0.11:
                raise AudioError("参考步频必须对应当前 BPM 的半拍、原拍或双拍")
            multiplier = reference / reference_bpm
            measured_tempo = self._refine_tempo(current.tempo, current.alignment, include_adapted=True)
            local_speed = cadence / (measured_tempo.bpm * multiplier)
            previous_speed = current.adaptation.speed if current.adaptation else 1
            total_speed = previous_speed * local_speed
            original_audio = self.track_path(original_id)
            track_id = uuid.uuid4().hex
            directory = self.tracks_dir / track_id
            directory.mkdir()
            try:
                with PROCESSING_LIMIT:
                    # Always render from the first source rather than stretching an
                    # already processed file a second time. Variable-tempo sources
                    # get a measured piecewise render; stable sources keep the
                    # existing single-filter path for identical, predictable output.
                    output_music_bpm = measured_tempo.bpm * total_speed
                    segments, adaptive_anchor = plan_segments(
                        original_audio, measured_tempo.bpm, output_music_bpm, total_speed,
                    )
                    if segments and adaptive_anchor is not None:
                        render_segments(
                            original_audio, directory / "audio.wav", segments,
                            output_music_bpm, adaptive_anchor,
                        )
                        drift_ms, coverage = measure_segments(
                            directory / "audio.wav", segments, output_music_bpm,
                            cadence, adaptive_anchor,
                        )
                        adaptation = Adaptation(
                            original_id=original_id, speed=total_speed,
                            reference_cadence=reference, target_cadence=cadence,
                            mode="adaptive", segments=segments,
                            drift_ms=drift_ms, coverage=coverage,
                        )
                    else:
                        change_tempo(original_audio, directory / "audio.wav", total_speed)
                        adaptation = Adaptation(
                            original_id=original_id, speed=total_speed,
                            reference_cadence=reference, target_cadence=cadence,
                        )
                    adapted_tempo = Tempo(
                        bpm=round(measured_tempo.bpm * local_speed, 4),
                        confidence=current.tempo.confidence,
                        status=current.tempo.status, source="adapted",
                    )
                    original_title = self.get(original_id).title
                    title = f"{original_title} · {cadence:g} 步/分"
                    return self._finish_track(track_id, title, current.source, adapted_tempo, adaptation)
            except Exception:
                shutil.rmtree(directory, ignore_errors=True)
                raise
        finally:
            release()
