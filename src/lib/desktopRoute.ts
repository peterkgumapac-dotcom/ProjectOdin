function normalizeRoute(route: string): string {
  if (!route.startsWith("/") || route.startsWith("//")) return "/dashboard"
  return route
}

export function odinRouteUrl(route: string): string {
  const safeRoute = normalizeRoute(route)
  if (window.odinDesktop?.routeUrl) return window.odinDesktop.routeUrl(safeRoute)
  return `${window.location.origin}${safeRoute}`
}

export function odinWindowUrl(route: string): string {
  const safeRoute = normalizeRoute(route)
  if (window.odinDesktop?.isPackaged) {
    return `${window.location.href.split("#")[0]}#${safeRoute}`
  }
  return `${window.location.origin}${safeRoute}`
}
