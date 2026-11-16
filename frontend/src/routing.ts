export type WorkspacePage =
  | "library"
  | "import"
  | "mix"
  | "rhythm"
  | "export"
  | "appearance";

export type AppRoute =
  | { page: WorkspacePage }
  | { page: "track" | "alignment"; entryId: string };

export const PAGE_TITLES: Record<AppRoute["page"], string> = {
  library: "我的曲库",
  import: "添加音乐",
  mix: "配乐编排",
  rhythm: "节奏与混音",
  track: "单曲调试",
  alignment: "节拍校准",
  export: "导出中心",
  appearance: "背景与外观",
};

export function parseRoute(hash: string, hasProject: boolean): AppRoute {
  const fallback: AppRoute = { page: hasProject ? "mix" : "library" };
  const segments = hash.replace(/^#\/?/, "").split("/");
  const page = segments[0];
  const trackPage = segments.length === 2 ||
    (segments.length === 3 && segments[2] === "align");
  if (page === "track" && trackPage && segments[1]) {
    try {
      return {
        page: segments.length === 3 ? "alignment" : "track",
        entryId: decodeURIComponent(segments[1]),
      };
    } catch {
      return fallback;
    }
  }
  if (segments.length === 1 && Object.hasOwn(PAGE_TITLES, page) && page !== "track" && page !== "alignment") {
    return { page: page as WorkspacePage };
  }
  return fallback;
}

export function routeHash(route: AppRoute): string {
  if (route.page === "track" || route.page === "alignment") {
    const suffix = route.page === "alignment" ? "/align" : "";
    return `#/track/${encodeURIComponent(route.entryId)}${suffix}`;
  }
  return `#/${route.page}`;
}
