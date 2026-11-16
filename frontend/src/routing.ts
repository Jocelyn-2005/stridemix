export type WorkspacePage =
  | "library"
  | "import"
  | "mix"
  | "rhythm"
  | "export"
  | "appearance";

export type AppRoute =
  | { page: WorkspacePage }
  | { page: "track"; entryId: string };

export const PAGE_TITLES: Record<AppRoute["page"], string> = {
  library: "我的曲库",
  import: "添加音乐",
  mix: "配乐编排",
  rhythm: "节奏与混音",
  track: "单曲调试",
  export: "导出中心",
  appearance: "背景与外观",
};

export function parseRoute(hash: string, hasProject: boolean): AppRoute {
  const fallback: AppRoute = { page: hasProject ? "mix" : "library" };
  const segments = hash.replace(/^#\/?/, "").split("/");
  const page = segments[0];
  if (page === "track" && segments.length === 2 && segments[1]) {
    try {
      return { page, entryId: decodeURIComponent(segments[1]) };
    } catch {
      return fallback;
    }
  }
  if (segments.length === 1 && Object.hasOwn(PAGE_TITLES, page) && page !== "track") {
    return { page: page as WorkspacePage };
  }
  return fallback;
}

export function routeHash(route: AppRoute): string {
  return route.page === "track"
    ? `#/track/${encodeURIComponent(route.entryId)}`
    : `#/${route.page}`;
}
