from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Track(BaseModel):
    id: str
    title: str
    duration: float
    source: str
    preview_url: str
    waveform: list[float]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=300)

    @field_validator("query")
    @classmethod
    def strip_query(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("请输入歌名")
        return value


class UrlRequest(BaseModel):
    url: str = Field(min_length=1, max_length=4000)


class GenerationRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4100)
    duration: float = Field(default=60, ge=3, le=600)

    @field_validator("prompt")
    @classmethod
    def strip_prompt(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("请输入配乐描述")
        return value


class TrackReference(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")


class ExportRequest(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    tracks: list[TrackReference] = Field(min_length=1, max_length=200)
    cadence: float = Field(default=165, ge=60, le=240)
    tone: Literal["click", "wood", "rim", "soft", "beep", "shaker"] = "wood"
    bgm_volume: float = Field(default=0.65, ge=0, le=1)
    beat_volume: float = Field(default=0.55, ge=0, le=1)
    format: Literal["mp3", "wav"] = "mp3"


class Job(BaseModel):
    id: str
    status: Literal["queued", "processing", "completed", "failed", "cancelled"]
    progress: float = 0
    error: str | None = None
    download_url: str | None = None
