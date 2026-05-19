export type SpotifyPlaybackReadiness =
  | "connected"
  | "needs_reconnect"
  | "policy_blocked"
  | "no_device"
  | "ready"

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function spotifyReadinessFromError(error: unknown): SpotifyPlaybackReadiness {
  const message = errorText(error)
  if (/401|unauthorized|token_revoked|invalid_auth|reconnect/i.test(message)) {
    return "needs_reconnect"
  }
  if (/403|premium|allowlist|forbidden/i.test(message)) {
    return "policy_blocked"
  }
  if (/404|no active device|NO_ACTIVE_DEVICE|not found/i.test(message)) {
    return "no_device"
  }
  return "connected"
}

export function spotifyReadinessMessage(state: SpotifyPlaybackReadiness): string {
  if (state === "needs_reconnect") {
    return "Spotify authorization expired. Reconnect Spotify in Connections."
  }
  if (state === "policy_blocked") {
    return "Spotify Premium/allowlist required."
  }
  if (state === "no_device") {
    return "Open Spotify on this Mac or phone and play one track first."
  }
  if (state === "ready") {
    return "Spotify is ready."
  }
  return "Spotify is connected."
}
