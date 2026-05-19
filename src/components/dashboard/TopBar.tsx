import { useCallback, useEffect, useMemo, useState } from "react"
import type React from "react"
import {
  Activity,
  Bell,
  Cloud,
  Globe2,
  LayoutGrid,
  LocateFixed,
  MapPin,
  Plus,
  Trash2,
} from "lucide-react"
import { OdinEyeMark } from "./OdinEyeMark"
import { useAuth } from "@/hooks/useAuth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  getWeatherLocationPermissionState,
  resolveWeatherLocationForOdin,
} from "@/lib/weatherLocation"
import {
  isLiveScanSourceEnabled,
  subscribeLiveScanRefresh,
} from "@/lib/liveScanRefresh"

const WEATHER_REFRESH_MS = 6 * 60 * 60_000
const CLOCKS_STORAGE_KEY = "odin.topbar.worldClocks.v1"
const WEATHER_LOCATION_STORAGE_KEY = "odin.topbar.weatherLocation.v1"
const WEATHER_CACHE_PREFIX = "odin.topbar.weather.v1"

const DEFAULT_WEATHER_LOCATION: WeatherLocation = {
  lat: 14.1709,
  lon: 121.2437,
  label: "Laguna, PH",
  source: "default",
}

const TIMEZONE_OPTIONS = [
  { label: "Laguna / Manila, Philippines", timezone: "Asia/Manila" },
  { label: "Nashville, US Central", timezone: "America/Chicago" },
  { label: "Oslo, Norway", timezone: "Europe/Oslo" },
  { label: "New York, US Eastern", timezone: "America/New_York" },
  { label: "Los Angeles, US Pacific", timezone: "America/Los_Angeles" },
  { label: "Honolulu, Hawaii", timezone: "Pacific/Honolulu" },
  { label: "Toronto, Canada", timezone: "America/Toronto" },
  { label: "Vancouver, Canada", timezone: "America/Vancouver" },
  { label: "London, United Kingdom", timezone: "Europe/London" },
  { label: "Paris, France", timezone: "Europe/Paris" },
  { label: "Dubai, UAE", timezone: "Asia/Dubai" },
  { label: "Singapore", timezone: "Asia/Singapore" },
  { label: "Tokyo, Japan", timezone: "Asia/Tokyo" },
  { label: "Sydney, Australia", timezone: "Australia/Sydney" },
  { label: "Auckland, New Zealand", timezone: "Pacific/Auckland" },
]

const DEFAULT_CLOCKS: WorldClock[] = [
  { id: "laguna", label: "Laguna", timezone: "Asia/Manila" },
  { id: "nashville", label: "Nashville", timezone: "America/Chicago" },
  { id: "oslo", label: "Oslo", timezone: "Europe/Oslo" },
]

interface WeatherState {
  tempC: number | null
  code: number | null
  loading: boolean
  refreshing: boolean
  error: string | null
}

interface WeatherLocation {
  lat: number
  lon: number
  label: string
  source: "default" | "browser" | "manual"
}

interface CachedWeather {
  tempC: number
  code: number | null
  checkedAt: string
}

interface WorldClock {
  id: string
  label: string
  timezone: string
}

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number
    weather_code?: number
  }
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function formatDate(d: Date): string {
  return d
    .toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase()
}

function formatClockTime(now: Date, timezone: string): string {
  try {
    return now.toLocaleTimeString(undefined, {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  } catch {
    return "--:--"
  }
}

function formatClockDay(now: Date, timezone: string): string {
  try {
    return now.toLocaleDateString(undefined, {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
    })
  } catch {
    return "Invalid timezone"
  }
}

function initials(email: string | undefined): string {
  if (!email) return "OD"
  const local = email.split("@")[0]
  const parts = local.split(/[._-]/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return local.slice(0, 2).toUpperCase()
}

function weatherSummary(code: number | null): string {
  if (code === null) return "Live weather"
  if (code === 0) return "Clear"
  if ([1, 2, 3].includes(code)) return "Clouds"
  if ([45, 48].includes(code)) return "Fog"
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle"
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain"
  if ([95, 96, 99].includes(code)) return "Storm"
  return "Weather"
}

function weatherCacheKey(location: WeatherLocation): string {
  return `${WEATHER_CACHE_PREFIX}.${location.lat.toFixed(4)}.${location.lon.toFixed(4)}`
}

function isFreshWeatherCache(checkedAt: string | null | undefined): boolean {
  if (!checkedAt) return false
  const time = new Date(checkedAt).getTime()
  if (!Number.isFinite(time)) return false
  return Date.now() - time <= WEATHER_REFRESH_MS
}

function readCachedWeather(location: WeatherLocation): CachedWeather | null {
  try {
    const raw = window.localStorage.getItem(weatherCacheKey(location))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CachedWeather>
    if (typeof parsed.tempC !== "number" || typeof parsed.checkedAt !== "string") {
      return null
    }
    return {
      tempC: parsed.tempC,
      code: typeof parsed.code === "number" ? parsed.code : null,
      checkedAt: parsed.checkedAt,
    }
  } catch {
    return null
  }
}

function writeCachedWeather(location: WeatherLocation, weather: CachedWeather) {
  try {
    window.localStorage.setItem(weatherCacheKey(location), JSON.stringify(weather))
  } catch {
    // Weather cache is only for API thrift; the dashboard can still render live fetches.
  }
}

function isLegacyManilaDefault(location: Partial<WeatherLocation>): boolean {
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

function readStoredLocation(): WeatherLocation {
  try {
    const raw = window.localStorage.getItem(WEATHER_LOCATION_STORAGE_KEY)
    if (!raw) return DEFAULT_WEATHER_LOCATION
    const parsed = JSON.parse(raw) as Partial<WeatherLocation>
    if (
      typeof parsed.lat === "number" &&
      typeof parsed.lon === "number" &&
      typeof parsed.label === "string"
    ) {
      if (isLegacyManilaDefault(parsed)) return DEFAULT_WEATHER_LOCATION
      return {
        lat: parsed.lat,
        lon: parsed.lon,
        label: parsed.label,
        source: parsed.source ?? "manual",
      }
    }
  } catch {
    // Weather location persistence is best effort.
  }
  return DEFAULT_WEATHER_LOCATION
}

function readStoredClocks(): WorldClock[] {
  try {
    const raw = window.localStorage.getItem(CLOCKS_STORAGE_KEY)
    if (!raw) return DEFAULT_CLOCKS
    const parsed = JSON.parse(raw) as WorldClock[]
    if (!Array.isArray(parsed)) return DEFAULT_CLOCKS
    return parsed.filter(
      (clock) =>
        typeof clock.id === "string" &&
        typeof clock.label === "string" &&
        typeof clock.timezone === "string"
    )
  } catch {
    return DEFAULT_CLOCKS
  }
}

function useWeatherLocation() {
  const [location, setLocation] = useState<WeatherLocation>(() =>
    readStoredLocation()
  )
  const [weather, setWeather] = useState<WeatherState>({
    tempC: null,
    code: null,
    loading: true,
    refreshing: false,
    error: null,
  })
  const [locating, setLocating] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [permissionState, setPermissionState] = useState<
    PermissionState | "unsupported" | "unknown"
  >("unknown")

  useEffect(() => {
    if (location.source === "browser") return
    if (!navigator.permissions?.query || !navigator.geolocation) return

    let cancelled = false
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((status) => {
        setPermissionState(status.state)
        status.onchange = () => setPermissionState(status.state)
        if (!cancelled && status.state === "granted") {
          void requestBrowserLocation()
        }
      })
      .catch(() => {
        // Location permission status is optional; manual location still works.
      })

    return () => {
      cancelled = true
    }
  }, [location.source])

  useEffect(() => {
    let mounted = true
    getWeatherLocationPermissionState().then((state) => {
      if (mounted) setPermissionState(state)
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        WEATHER_LOCATION_STORAGE_KEY,
        JSON.stringify(location)
      )
    } catch {
      // Location persistence is only for convenience.
    }
  }, [location])

  useEffect(() => {
    let cancelled = false
    const cached = readCachedWeather(location)

    async function fetchWeather(silent = false) {
      setWeather((current) => ({
        ...current,
        loading: silent ? current.loading : true,
        refreshing: silent,
        error: null,
      }))

      try {
        const params = new URLSearchParams({
          latitude: String(location.lat),
          longitude: String(location.lon),
          current: "temperature_2m,weather_code",
          timezone: "auto",
        })
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?${params.toString()}`
        )
        if (!response.ok) throw new Error(`Weather HTTP ${response.status}`)
        const data = (await response.json()) as OpenMeteoResponse
        const temp = data.current?.temperature_2m
        const code = data.current?.weather_code
        if (typeof temp !== "number") throw new Error("No temperature")
        if (cancelled) return
        const checkedAt = new Date().toISOString()
        writeCachedWeather(location, {
          tempC: temp,
          code: typeof code === "number" ? code : null,
          checkedAt,
        })
        setWeather({
          tempC: temp,
          code: typeof code === "number" ? code : null,
          loading: false,
          refreshing: false,
          error: null,
        })
      } catch (err) {
        if (cancelled) return
        setWeather({
          tempC: null,
          code: null,
          loading: false,
          refreshing: false,
          error: err instanceof Error ? err.message : "Weather unavailable",
        })
      }
    }

    if (cached) {
      setWeather({
        tempC: cached.tempC,
        code: cached.code,
        loading: false,
        refreshing: false,
        error: null,
      })
    }

    const shouldForceRefresh = refreshNonce > 0
    if (shouldForceRefresh || !cached || !isFreshWeatherCache(cached.checkedAt)) {
      void fetchWeather(Boolean(cached))
    }
    const interval = setInterval(() => void fetchWeather(true), WEATHER_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [location, refreshNonce])

  const refreshWeather = useCallback(() => {
    setRefreshNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    return subscribeLiveScanRefresh((signal) => {
      if (!isLiveScanSourceEnabled(signal, "weather")) return
      refreshWeather()
    })
  }, [refreshWeather])

  async function requestBrowserLocation() {
    if (!navigator.geolocation) {
      setWeather((current) => ({
        ...current,
        error: "Browser location is unavailable",
      }))
      return
    }

    setLocating(true)
    try {
      const result = await resolveWeatherLocationForOdin({ requestPermission: true })
      setLocation(result.location)
      setPermissionState(await getWeatherLocationPermissionState())
      setWeather((current) => ({
        ...current,
        error: result.warning ?? null,
      }))
    } finally {
      setLocating(false)
    }
  }

  function setManualLocation(nextLocation: WeatherLocation) {
    setLocation(nextLocation)
  }

  return {
    location,
    weather,
    locating,
    permissionState,
    requestBrowserLocation,
    setManualLocation,
    refreshWeather,
  }
}

export function TopBar() {
  const { user, signOut } = useAuth()
  const [now, setNow] = useState(new Date())
  const [panelOpen, setPanelOpen] = useState(false)
  const [clocks, setClocks] = useState<WorldClock[]>(() => readStoredClocks())
  const [clockLabel, setClockLabel] = useState("")
  const [timezone, setTimezone] = useState(TIMEZONE_OPTIONS[0].timezone)
  const {
    location,
    weather,
    locating,
    permissionState,
    requestBrowserLocation,
    setManualLocation,
  } = useWeatherLocation()

  const selectedClockOption = useMemo(
    () => TIMEZONE_OPTIONS.find((option) => option.timezone === timezone),
    [timezone]
  )

  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      setNow(new Date())
    }
    const handleVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        setNow(new Date())
      }
    }
    const t = setInterval(tick, 30_000)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisible)
    }
    return () => {
      clearInterval(t)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisible)
      }
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(CLOCKS_STORAGE_KEY, JSON.stringify(clocks))
    } catch {
      // Clock persistence is only for dashboard convenience.
    }
  }, [clocks])

  function addClock() {
    const option = selectedClockOption
    const label = (clockLabel || option?.label.split(",")[0] || timezone).trim()
    if (!label || clocks.some((clock) => clock.timezone === timezone)) return
    setClocks((current) => [
      ...current,
      {
        id: `${timezone}-${Date.now()}`,
        label,
        timezone,
      },
    ])
    setClockLabel("")
  }

  function selectPresetWeather(option: (typeof TIMEZONE_OPTIONS)[number]) {
    const preset = weatherPresetForTimezone(option.timezone)
    if (!preset) return
    setManualLocation({
      ...preset,
      label: preset.label,
      source: "manual",
    })
  }

  return (
    <header
      className="h-[72px] w-full border-b border-border/60 backdrop-blur-md bg-background/40 flex items-center px-6 gap-6"
      style={{ gridArea: "topbar" }}
    >
      {/* Left: brand */}
      <div className="flex items-center gap-4 min-w-0">
        <div className="w-10 h-10 rounded-full border border-gold/40 flex items-center justify-center bg-surface/60 text-gold">
          <OdinEyeMark className="h-7 w-7" />
        </div>
        <div className="flex items-center gap-4">
          <span className="font-display text-lg tracking-widest text-foreground">
            GUMAPAC
          </span>
          <span className="h-6 w-px bg-border" />
          <div className="flex flex-col leading-tight">
            <span className="font-display text-lg tracking-widest text-gold">
              ODIN
            </span>
            <span className="label-track text-tertiary -mt-0.5">
              OPERATIONS
            </span>
          </div>
        </div>
      </div>

      {/* Center: time */}
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        className="flex-1 flex flex-col items-center justify-center rounded-md px-3 py-1 hover:bg-surface/45 transition-colors"
        title="Manage world clocks"
      >
        <span className="font-mono-data text-2xl text-foreground tabular-nums">
          {formatTime(now)}
        </span>
        <span className="label-track text-tertiary mt-0.5">
          {formatDate(now)}
        </span>
        {clocks.length > 0 && (
          <span className="mt-1 hidden xl:flex items-center gap-3 text-[10px] uppercase tracking-wider text-tertiary">
            {clocks.slice(0, 3).map((clock) => (
              <span key={clock.id}>
                {clock.label}{" "}
                <span className="font-mono-data text-muted-foreground">
                  {formatClockTime(now, clock.timezone)}
                </span>
              </span>
            ))}
          </span>
        )}
      </button>

      {/* Right: weather + icons + avatar */}
      <div className="flex items-center gap-5">
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="hidden md:flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground transition-colors"
          title={
            weather.error
              ? `Weather unavailable: ${weather.error}`
              : `${weatherSummary(weather.code)} in ${location.label}`
          }
        >
          <Cloud size={16} className="text-frost" />
          <span className="font-mono-data text-foreground">
            {weather.loading
              ? "--°"
              : weather.tempC === null
                ? "N/A"
                : `${Math.round(weather.tempC)}°`}
          </span>
          <span className="label-track max-w-28 truncate">
            {location.label}
          </span>
        </button>

        <div className="flex items-center gap-2">
          <IconGlyph ariaLabel="Activity status">
            <Activity size={16} />
          </IconGlyph>
          <IconGlyph ariaLabel="Dashboard grid status">
            <LayoutGrid size={16} />
          </IconGlyph>
          <div className="relative">
            <IconGlyph ariaLabel="Notification status">
              <Bell size={16} />
            </IconGlyph>
            <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-gold gold-glow" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold bg-surface border border-gold/40 text-gold gold-glow"
            title={user?.email ?? ""}
          >
            {initials(user?.email)}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={signOut}
            className="text-tertiary hover:text-foreground"
          >
            Sign out
          </Button>
        </div>
      </div>

      <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto scrollbar-thin">
          <DialogHeader>
            <DialogTitle className="font-display tracking-[0.18em] text-gold">
              Time & Weather
            </DialogTitle>
            <DialogDescription>
              Manage dashboard weather location and world clocks.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-[1fr_1.2fr]">
            <section className="rounded-lg border border-border/70 bg-background/30 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="label-track text-tertiary">Weather</div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="font-mono-data text-3xl text-foreground">
                      {weather.loading
                        ? "--°"
                        : weather.tempC === null
                          ? "N/A"
                          : `${Math.round(weather.tempC)}°`}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {weatherSummary(weather.code)}
                    </span>
                  </div>
                </div>
                <Cloud className="text-frost" size={28} />
              </div>

              <div className="mt-4 flex items-start gap-2 text-sm text-muted-foreground">
                <MapPin size={14} className="mt-0.5 text-gold" />
                <div>
                  <div className="text-foreground">{location.label}</div>
                  <div className="text-xs">
                    {location.source === "browser"
                      ? "Browser location"
                      : "Saved dashboard location"}
                    {weather.refreshing ? " · refreshing quietly" : ""}
                  </div>
                  <div className="mt-1 text-[11px] text-tertiary">
                    Location permission: {permissionState}
                  </div>
                </div>
              </div>

              {weather.error && (
                <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {weather.error}
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void requestBrowserLocation()}
                  disabled={locating}
                  className="gap-2"
                >
                  <LocateFixed size={14} />
                  {locating
                    ? "Locating"
                    : permissionState === "granted"
                      ? "Use Exact Location"
                      : permissionState === "denied"
                        ? "Location Blocked"
                        : "Allow Location"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => selectPresetWeather(TIMEZONE_OPTIONS[0])}
                >
                  Laguna
                </Button>
              </div>
            </section>

            <section className="rounded-lg border border-border/70 bg-background/30 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="label-track text-tertiary">World Clocks</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add countries or operating timezones you want ODIN to keep visible.
                  </p>
                </div>
                <Globe2 className="text-gold" size={22} />
              </div>

              <div className="mt-4 space-y-2">
                {clocks.map((clock) => (
                  <div
                    key={clock.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-surface/45 px-3 py-2"
                  >
                    <div>
                      <div className="font-medium text-foreground">
                        {clock.label}
                      </div>
                      <div className="text-xs text-tertiary">
                        {formatClockDay(now, clock.timezone)} · {clock.timezone}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono-data text-xl text-gold">
                        {formatClockTime(now, clock.timezone)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${clock.label}`}
                        onClick={() =>
                          setClocks((current) =>
                            current.filter((item) => item.id !== clock.id)
                          )
                        }
                        className="text-tertiary hover:text-destructive"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid gap-2">
                <select
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  {TIMEZONE_OPTIONS.map((option) => (
                    <option key={option.timezone} value={option.timezone}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <Input
                    value={clockLabel}
                    onChange={(event) => setClockLabel(event.target.value)}
                    placeholder={selectedClockOption?.label.split(",")[0] ?? "Label"}
                    className="h-9"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={addClock}
                    className="gap-2"
                  >
                    <Plus size={14} />
                    Add
                  </Button>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    selectedClockOption && selectPresetWeather(selectedClockOption)
                  }
                  className="justify-start gap-2 text-tertiary hover:text-foreground"
                >
                  <MapPin size={14} />
                  Use selected city for weather
                </Button>
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  )
}

function weatherPresetForTimezone(timezone: string) {
  const presets: Record<string, Omit<WeatherLocation, "source">> = {
    "Asia/Manila": { lat: 14.1709, lon: 121.2437, label: "Laguna, PH" },
    "America/Chicago": { lat: 36.1627, lon: -86.7816, label: "Nashville, US" },
    "Europe/Oslo": { lat: 59.9139, lon: 10.7522, label: "Oslo, NO" },
    "America/New_York": { lat: 40.7128, lon: -74.006, label: "New York, US" },
    "America/Los_Angeles": { lat: 34.0522, lon: -118.2437, label: "Los Angeles, US" },
    "Pacific/Honolulu": { lat: 21.3099, lon: -157.8581, label: "Honolulu, US" },
    "America/Toronto": { lat: 43.6532, lon: -79.3832, label: "Toronto, CA" },
    "America/Vancouver": { lat: 49.2827, lon: -123.1207, label: "Vancouver, CA" },
    "Europe/London": { lat: 51.5072, lon: -0.1276, label: "London, UK" },
    "Europe/Paris": { lat: 48.8566, lon: 2.3522, label: "Paris, FR" },
    "Asia/Dubai": { lat: 25.2048, lon: 55.2708, label: "Dubai, AE" },
    "Asia/Singapore": { lat: 1.3521, lon: 103.8198, label: "Singapore" },
    "Asia/Tokyo": { lat: 35.6762, lon: 139.6503, label: "Tokyo, JP" },
    "Australia/Sydney": { lat: -33.8688, lon: 151.2093, label: "Sydney, AU" },
    "Pacific/Auckland": { lat: -36.8509, lon: 174.7645, label: "Auckland, NZ" },
  }
  return presets[timezone] ?? null
}

function IconGlyph({
  children,
  ariaLabel,
}: {
  children: React.ReactNode
  ariaLabel: string
}) {
  return (
    <span
      aria-label={ariaLabel}
      className="w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground"
    >
      {children}
    </span>
  )
}
