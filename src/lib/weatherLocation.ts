export type OdinWeatherLocationState = {
  lat: number
  lon: number
  label: string
  source: "default" | "browser" | "manual"
}

export type WeatherLocationResolution = {
  location: OdinWeatherLocationState
  status: "browser" | "saved" | "default" | "denied" | "unsupported" | "error"
  warning?: string
}

const WEATHER_LOCATION_STORAGE_KEY = "odin.topbar.weatherLocation.v1"

export const DEFAULT_ODIN_WEATHER_LOCATION: OdinWeatherLocationState = {
  lat: 14.1709,
  lon: 121.2437,
  label: "Laguna, PH",
  source: "default",
}

function isLegacyManilaDefault(location: Partial<OdinWeatherLocationState>): boolean {
  const label = location.label?.toLowerCase() ?? ""
  const lat = typeof location.lat === "number" ? location.lat : null
  const lon = typeof location.lon === "number" ? location.lon : null
  return (
    label.includes("manila") ||
    (lat !== null &&
      lon !== null &&
      Math.abs(lat - 14.5995) < 0.01 &&
      Math.abs(lon - 120.9842) < 0.01)
  )
}

export function readStoredWeatherLocation(): OdinWeatherLocationState {
  if (typeof window === "undefined") return DEFAULT_ODIN_WEATHER_LOCATION
  try {
    const raw = window.localStorage.getItem(WEATHER_LOCATION_STORAGE_KEY)
    if (!raw) return DEFAULT_ODIN_WEATHER_LOCATION
    const parsed = JSON.parse(raw) as Partial<OdinWeatherLocationState>
    if (
      typeof parsed.lat === "number" &&
      Number.isFinite(parsed.lat) &&
      typeof parsed.lon === "number" &&
      Number.isFinite(parsed.lon) &&
      typeof parsed.label === "string" &&
      parsed.label.trim()
    ) {
      if (isLegacyManilaDefault(parsed)) return DEFAULT_ODIN_WEATHER_LOCATION
      return {
        lat: parsed.lat,
        lon: parsed.lon,
        label: parsed.label,
        source: parsed.source ?? "manual",
      }
    }
  } catch {
    // Weather location persistence is a convenience, not a hard dependency.
  }
  return DEFAULT_ODIN_WEATHER_LOCATION
}

export function writeStoredWeatherLocation(location: OdinWeatherLocationState) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(WEATHER_LOCATION_STORAGE_KEY, JSON.stringify(location))
  } catch {
    // Best effort only.
  }
}

export async function getWeatherLocationPermissionState(): Promise<
  PermissionState | "unsupported" | "unknown"
> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return "unsupported"
  if (!navigator.permissions?.query) return "unknown"
  try {
    const status = await navigator.permissions.query({
      name: "geolocation" as PermissionName,
    })
    return status.state
  } catch {
    return "unknown"
  }
}

function getBrowserPosition() {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 10 * 60_000,
    })
  })
}

export async function resolveWeatherLocationForOdin(
  options: { requestPermission?: boolean } = {}
): Promise<WeatherLocationResolution> {
  const saved = readStoredWeatherLocation()
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return {
      location: saved,
      status: saved.source === "default" ? "unsupported" : "saved",
      warning: "Browser location is unavailable; ODIN used the saved weather location.",
    }
  }

  const permission = await getWeatherLocationPermissionState()
  if (permission === "denied") {
    return {
      location: saved,
      status: "denied",
      warning: "Location permission is blocked; ODIN used the saved weather location.",
    }
  }

  if (!options.requestPermission && permission !== "granted") {
    return { location: saved, status: saved.source === "default" ? "default" : "saved" }
  }

  try {
    const position = await getBrowserPosition()
    const browserLocation: OdinWeatherLocationState = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      label: "Current location",
      source: "browser",
    }
    const location = browserLocation
    writeStoredWeatherLocation(location)
    return { location, status: "browser" }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Location permission was not granted."
    return {
      location: saved,
      status: "error",
      warning: `${message} ODIN used the saved weather location.`,
    }
  }
}
