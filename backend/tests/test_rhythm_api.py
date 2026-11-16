import io
import wave

import numpy as np
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.audio import SAMPLE_RATE


def pulse_file():
    samples = np.zeros(12 * SAMPLE_RATE, dtype=np.float64)
    attack = np.arange(round(0.07 * SAMPLE_RATE)) / SAMPLE_RATE
    pulse = np.sin(2 * np.pi * 110 * attack) * np.exp(-attack * 70)
    for beat in np.arange(0.173, 12 - 0.07, 60 / 165):
        start = round(beat * SAMPLE_RATE)
        samples[start:start + len(pulse)] += pulse
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes((samples * 24000).astype("<i2").tobytes())
    return output.getvalue()


def test_rhythm_endpoint_exposes_pcm_evidence_and_bounds_requests(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        track = client.post('/api/tracks/upload', files={'file':('pulses.wav', pulse_file(), 'audio/wav')}).json()
        response = client.get(f"/api/tracks/{track['id']}/rhythm", params={'start_seconds':3, 'duration_seconds':5})
        assert response.status_code == 200
        evidence = response.json()
        assert evidence['start_seconds'] == 3
        assert evidence['duration_seconds'] == 5
        assert len(evidence['envelope']) <= 512
        assert len(evidence['onsets']) >= 10
        assert all(3 <= onset['time'] < 8 for onset in evidence['onsets'])
        assert evidence['reliability'] > 0.5
        assert client.get(f"/api/tracks/{track['id']}/rhythm?duration_seconds=31").status_code == 422
        assert client.get(f"/api/tracks/{track['id']}/rhythm?start_seconds=-1").status_code == 422
        assert client.get('/api/tracks/missing/rhythm').status_code == 404
        assert client.app.state.library.media_uses == {}


def test_reanalysis_replaces_legacy_manual_bpm_with_measured_audio(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        track = client.post('/api/tracks/upload', files={'file':('pulses.wav', pulse_file(), 'audio/wav')}).json()
        client.patch(f"/api/tracks/{track['id']}/tempo", json={'bpm':100})
        response = client.post(f"/api/tracks/{track['id']}/reanalyze")
        assert response.status_code == 200
        updated = response.json()
        assert updated['tempo']['source'] == 'analysis'
        assert abs(updated['tempo']['bpm'] - 165) < 0.5
        assert updated['alignment']['anchor_seconds'] is not None
        assert client.app.state.library.media_uses == {}
