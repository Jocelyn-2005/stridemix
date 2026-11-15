# StrideMix Implementation Plan

> Execute in the current session with focused implementation agents and independent review.

**Goal** Build and publish a usable local running-music editor with independent metronome and BGM tracks.

**Architecture** React and Web Audio provide the editing and preview interface. FastAPI manages local media and background export jobs. FFmpeg normalizes and mixes files using bounded memory, yt-dlp resolves searchable music and supported video links, and ElevenLabs supplies optional AI music.

**Tech Stack** Python 3.11+, FastAPI, NumPy, imageio-ffmpeg, yt-dlp, HTTPX, React 19, TypeScript, Vite, lucide-react.

## Task 1 — Audio service

Create backend/app.py, backend/audio.py, backend/models.py and backend/tests. Implement the API contract below, normalized local media storage, deterministic tone WAVs and asynchronous exact-timeline exports. Add focused tests for beat timing and volume isolation, then run pytest against actual FFmpeg output. Keep generated audio out of git.

## Task 2 — Browser editor

Create frontend/src and frontend build configuration. Implement upload, link import, title search, AI prompt entry, reorder/removal, transport, seeking, cadence/timbre controls, independent volume controls and export job progress/download. Preview uses streamed BGM plus audio-clock metronome scheduling. Save project order/settings in localStorage and reconcile saved track IDs with the backend library. Run the production build and interact with normal browser entry points.

## Task 3 — Run and package

Create requirements.txt, start.py, platform start scripts, .env.example, README and LICENSE. A single launcher serves frontend/dist and /api on http://127.0.0.1:8765. Dependencies use a project-local venv, and FFmpeg uses imageio-ffmpeg's bundled executable when a system executable is unavailable. Install dependencies and build the UI.

## Task 4 — Review and publish

Perform a separate specification and code-quality review. Verify actual two-track exports, duration and cadence, browser desktop/mobile layouts, errors and production startup. Create the user's public GitHub repository, commit source and lockfiles, push, and verify the remote contents and final commit. Report externally dependent verification gaps explicitly.

## API contract

All JSON errors use FastAPI's detail field. All IDs are server-generated opaque strings. Volume values are 0..1. Cadence values are 60..240.

- GET /api/health returns {status, ffmpeg, ai_configured}.
- GET /api/tones returns [{id, name, description}]. IDs are click, wood, rim, soft, beep, shaker.
- GET /api/tones/{id}.wav returns the exact preview/export tone WAV.
- GET /api/tracks returns a Track array.
- POST /api/tracks/upload accepts one multipart file field named file and returns a Track.
- POST /api/search accepts {query} and returns {results:[{title,url,duration,channel}]}.
- POST /api/tracks/url accepts {url} and returns a Track.
- POST /api/tracks/generate accepts {prompt,duration} in seconds, 3..600, and returns a Track.
- GET /api/media/{id} serves normalized streamable audio.
- POST /api/exports accepts {tracks:[{id}],cadence,tone,bgm_volume,beat_volume,format} and returns a Job.
- GET /api/exports/{id} returns a Job.
- DELETE /api/exports/{id} cancels an active Job and returns it.
- GET /api/exports/{id}/download downloads the completed output.

Track is {id,title,duration,source,preview_url,waveform}. waveform is an array of 80 normalized peaks, source is a display string, duration is seconds, and preview_url is /api/media/{id}.

Job is {id,status,progress,error,download_url}. status is queued, processing, completed, failed or cancelled. progress is 0..100. error and download_url may be null.
