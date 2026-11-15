export interface Track {
  id: string;
  title: string;
  duration: number;
  source: string;
  preview_url: string;
  waveform: number[];
  tempo?: TrackTempo;
  adaptation?: TrackAdaptation | null;
}

export interface TrackTempo {
  bpm: number | null;
  confidence: number;
  status: "pending" | "detected" | "uncertain" | "unavailable";
  source: "analysis" | "manual" | "adapted";
}

export interface TrackAdaptation {
  original_id: string;
  speed: number;
  reference_cadence: number;
  target_cadence: number;
}

export interface Tone {
  id: string;
  name: string;
  description: string;
}

export interface Health {
  status: string;
  ffmpeg: boolean | string;
  ai_configured: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  duration: number | null;
  channel: string;
}

export interface ExportJob {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  error: string | null;
  download_url: string | null;
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === "string")
    headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const detail = payload?.detail;
    if (typeof detail === "string") throw new Error(detail);
    if (Array.isArray(detail))
      throw new Error(
        detail.map((item: { msg: string }) => item.msg).join("，"),
      );
    throw new Error(`请求失败（${response.status}），请稍后重试。`);
  }
  return response.json() as Promise<T>;
}
