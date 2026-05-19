import { useEffect, useId, useMemo, useRef, useState } from "react"

export type OdinCoreEyeMode = "idle" | "listening" | "speaking"
export type OdinCoreEyeExpression = "calm" | "attentive" | "speaking" | "concerned"

interface OdinCoreEyeProps {
  mode?: OdinCoreEyeMode
  size?: number
  expression?: OdinCoreEyeExpression
  trackCursor?: boolean
}

interface Point {
  x: number
  y: number
}

function polar(cx: number, cy: number, r: number, deg: number): Point {
  const a = ((deg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
}

function describeArc(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number
) {
  const s = polar(cx, cy, r, startDeg)
  const e = polar(cx, cy, r, endDeg)
  const large = endDeg - startDeg <= 180 ? 0 : 1
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`
}

export function OdinCoreEye({
  mode = "idle",
  size = 420,
  expression,
  trackCursor = false,
}: OdinCoreEyeProps) {
  const drawSize = Math.max(size, 320)
  const uid = useId().replace(/:/g, "")
  const [env, setEnv] = useState(0)
  const [phase, setPhase] = useState(0)
  const [gaze, setGaze] = useState(-Math.PI / 2)
  const [cursorGaze, setCursorGaze] = useState({ x: 0, y: 0 })
  const [drift, setDrift] = useState({ x: 0, y: 0 })
  const tRef = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const cursorRef = useRef({
    current: { x: 0, y: 0 },
    target: { x: 0, y: 0 },
  })
  const gazeRef = useRef({
    ang: -Math.PI / 2,
    paused: 0,
    target: -Math.PI / 2,
  })
  const resolvedExpression: OdinCoreEyeExpression =
    expression ?? (mode === "speaking" ? "speaking" : mode === "listening" ? "attentive" : "calm")

  useEffect(() => {
    if (!trackCursor) {
      cursorRef.current.target = { x: 0, y: 0 }
      return
    }

    const handlePointerMove = (event: PointerEvent) => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return

      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const dx = (event.clientX - cx) / Math.max(1, rect.width / 2)
      const dy = (event.clientY - cy) / Math.max(1, rect.height / 2)
      const distance = Math.hypot(dx, dy)
      const clamp = distance > 1 ? 1 / distance : 1
      cursorRef.current.target = {
        x: dx * clamp,
        y: dy * clamp,
      }
    }

    const handlePointerLeave = () => {
      cursorRef.current.target = { x: 0, y: 0 }
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerleave", handlePointerLeave)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerleave", handlePointerLeave)
    }
  }, [trackCursor])

  useEffect(() => {
    let raf = 0

    const tick = () => {
      tRef.current += 1 / 60
      const t = tRef.current
      setPhase(t)

      let v: number
      if (mode === "speaking") {
        v =
          0.55 +
          0.2 * Math.sin(t * 6.1) +
          0.15 * Math.sin(t * 11.7 + 1.3) +
          0.1 * Math.sin(t * 19.2 + 2.7)
        const gw = 0.5 + 0.5 * Math.sin(t * 1.7)
        v = Math.max(0, Math.min(1, v * (0.55 + 0.45 * gw)))
      } else if (mode === "listening") {
        v = 0.2 + 0.1 * Math.sin(t * 4.2) + 0.06 * Math.sin(t * 9.3 + 1)
      } else {
        v = 0.32 + 0.06 * Math.sin(t * 1.7)
      }
      setEnv(v)

      const gz = gazeRef.current
      if (gz.paused > 0) {
        gz.paused -= 1
        gz.ang += (gz.target - gz.ang) * 0.18
      } else {
        gz.target = (Math.random() - 0.5) * Math.PI * 2
        gz.paused =
          mode === "idle"
            ? 90 + Math.floor(Math.random() * 80)
            : mode === "listening"
              ? 40 + Math.floor(Math.random() * 30)
              : 160
      }
      setGaze(gz.ang)

      const cursor = cursorRef.current
      cursor.current = {
        x: cursor.current.x + (cursor.target.x - cursor.current.x) * 0.16,
        y: cursor.current.y + (cursor.target.y - cursor.current.y) * 0.16,
      }
      setCursorGaze(cursor.current)

      setDrift({
        x: Math.sin(t * 0.45) * 2.6 + Math.cos(t * 0.27) * 1.4,
        y: Math.cos(t * 0.38) * 2 + Math.sin(t * 0.31) * 1.2,
      })

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  const C = drawSize / 2
  const R_HOUSING = C - 4
  const R_BEZEL_RIM = C - 32
  const R_APERTURE_OUT = C - 38
  const R_APERTURE_IN = C - 76
  const R_IRIS_OUT = C - 78
  const R_IRIS_BAND_OUT = C - 84
  const R_IRIS_BAND_IN = C - 132

  const randomGazeWeight = trackCursor ? 0.28 : 1
  const cursorGazeWeight = trackCursor ? 15 : 0
  const speakingGazeDamp = mode === "speaking" ? 0.55 : 1
  const expressionPupilScale =
    resolvedExpression === "attentive"
      ? 0.92
      : resolvedExpression === "concerned"
        ? 0.78
        : resolvedExpression === "speaking"
          ? 1.08
          : 1
  const expressionGlow =
    resolvedExpression === "attentive"
      ? 1.12
      : resolvedExpression === "concerned"
        ? 0.72
        : resolvedExpression === "speaking"
          ? 1.24
          : 1
  const eyelidOpacity =
    resolvedExpression === "concerned"
      ? 0.78
      : resolvedExpression === "attentive"
        ? 0.38
        : 0.18
  const pupilDX =
    (Math.cos(gaze) * 8 * randomGazeWeight + cursorGaze.x * cursorGazeWeight) *
    speakingGazeDamp
  const pupilDY =
    (Math.sin(gaze) * 8 * randomGazeWeight + cursorGaze.y * cursorGazeWeight) *
    speakingGazeDamp

  const housingNotches = useMemo(() => {
    const N = 96
    return Array.from({ length: N }, (_, i) => {
      const ang = (i / N) * Math.PI * 2 - Math.PI / 2
      const major = i % 8 === 0
      const r1 = R_HOUSING - 1
      const r2 = R_HOUSING - (major ? 12 : 6)
      return {
        x1: C + Math.cos(ang) * r1,
        y1: C + Math.sin(ang) * r1,
        x2: C + Math.cos(ang) * r2,
        y2: C + Math.sin(ang) * r2,
        major,
      }
    })
  }, [C, R_HOUSING])

  const screws = useMemo(() => {
    const angs = [-Math.PI / 4, Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4]
    const r = R_HOUSING - 18
    return angs.map((a) => ({
      x: C + Math.cos(a) * r,
      y: C + Math.sin(a) * r,
      slot: a + Math.PI / 6,
    }))
  }, [C, R_HOUSING])

  const apertureBlades = useMemo(() => {
    const N = 8
    const gap = 0.012
    return Array.from({ length: N }, (_, i) => {
      const a1 = (i / N) * Math.PI * 2 + gap - Math.PI / 2
      const a2 = ((i + 1) / N) * Math.PI * 2 - gap - Math.PI / 2
      const innerA1 = a1 + 0.05
      const innerA2 = a2 - 0.05
      const x1 = C + Math.cos(a1) * R_APERTURE_OUT
      const y1 = C + Math.sin(a1) * R_APERTURE_OUT
      const x2 = C + Math.cos(a2) * R_APERTURE_OUT
      const y2 = C + Math.sin(a2) * R_APERTURE_OUT
      const x3 = C + Math.cos(innerA2) * R_APERTURE_IN
      const y3 = C + Math.sin(innerA2) * R_APERTURE_IN
      const x4 = C + Math.cos(innerA1) * R_APERTURE_IN
      const y4 = C + Math.sin(innerA1) * R_APERTURE_IN
      return {
        d: `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} L${x3.toFixed(1)} ${y3.toFixed(1)} L${x4.toFixed(1)} ${y4.toFixed(1)} Z`,
        edge: `M${x4.toFixed(1)} ${y4.toFixed(1)} L${x3.toFixed(1)} ${y3.toFixed(1)}`,
      }
    })
  }, [C, R_APERTURE_IN, R_APERTURE_OUT])

  const irisSpokes = useMemo(() => {
    const N = 84
    return Array.from({ length: N }, (_, i) => {
      const ang = (i / N) * Math.PI * 2
      return {
        x1: C + Math.cos(ang) * R_IRIS_BAND_OUT,
        y1: C + Math.sin(ang) * R_IRIS_BAND_OUT,
        x2: C + Math.cos(ang) * R_IRIS_BAND_IN,
        y2: C + Math.sin(ang) * R_IRIS_BAND_IN,
        op: 0.25 + 0.4 * ((i % 4) / 3),
      }
    })
  }, [C, R_IRIS_BAND_IN, R_IRIS_BAND_OUT])

  const bezelMarks = useMemo(() => {
    const angs = [0, Math.PI / 2, Math.PI, -Math.PI / 2]
    return angs.map((a) => ({
      x: C + Math.cos(a) * (R_HOUSING - 22),
      y: C + Math.sin(a) * (R_HOUSING - 22),
      rot: (a * 180) / Math.PI + 90,
    }))
  }, [C, R_HOUSING])

  const glintAngle = -Math.PI * 0.7 + Math.cos(gaze) * 0.18
  const glintR = R_IRIS_OUT - 6
  const glintStart = ((glintAngle - 0.42) * 180) / Math.PI + 90
  const glintEnd = ((glintAngle + 0.42) * 180) / Math.PI + 90
  const glintPath = describeArc(C, C, glintR, glintStart, glintEnd)
  const pupilBloom = (1 + env * 0.2) * expressionPupilScale

  const ids = {
    pupilCore: `${uid}-pupil-core`,
    pupilGlow: `${uid}-pupil-glow`,
    bezelMetal: `${uid}-bezel-metal`,
    bladeGrad: `${uid}-blade-grad`,
    irisBand: `${uid}-iris-band`,
    pupilBloom: `${uid}-pupil-bloom`,
  }

  return (
    <div
      ref={rootRef}
      className="odin-core-eye"
      data-mode={mode}
      data-expression={resolvedExpression}
      style={{
        position: "relative",
        width: size,
        height: size,
        pointerEvents: "none",
        userSelect: "none",
        transform: `translate(${drift.x.toFixed(2)}px, ${drift.y.toFixed(2)}px)`,
        willChange: "transform",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: -size * 0.25,
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--accent-soft) 0%, transparent 65%)",
          opacity: (0.55 + env * 0.25) * expressionGlow,
          filter: "blur(20px)",
          transition: "opacity .25s",
        }}
      />
      <div className="odin-core-eye__internal-field" aria-hidden="true" />
      <div className="odin-core-eye__internal-dust" aria-hidden="true" />
      <div className="odin-core-eye__depth-distortion" aria-hidden="true" />

      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${drawSize} ${drawSize}`}
        style={{ position: "absolute", inset: 0 }}
      >
        <defs>
          <radialGradient id={ids.pupilCore} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff8e8" stopOpacity="1" />
            <stop offset="18%" stopColor="var(--accent-glow)" stopOpacity="1" />
            <stop offset="55%" stopColor="var(--accent)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={ids.pupilGlow} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent-glow)" stopOpacity="0.6" />
            <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={ids.bezelMetal} cx="50%" cy="20%" r="80%">
            <stop offset="0%" stopColor="oklch(0.30 0.014 255)" />
            <stop offset="50%" stopColor="oklch(0.18 0.012 255)" />
            <stop offset="100%" stopColor="oklch(0.12 0.012 255)" />
          </radialGradient>
          <linearGradient id={ids.bladeGrad} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="oklch(0.22 0.014 255)" />
            <stop offset="50%" stopColor="oklch(0.16 0.012 255)" />
            <stop offset="100%" stopColor="oklch(0.10 0.012 255)" />
          </linearGradient>
          <radialGradient id={ids.irisBand} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="oklch(0.18 0.014 255)" />
            <stop offset="60%" stopColor="oklch(0.13 0.012 255)" />
            <stop offset="100%" stopColor="oklch(0.10 0.012 255)" />
          </radialGradient>
          <filter id={ids.pupilBloom} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" />
          </filter>
        </defs>

        <circle
          cx={C}
          cy={C}
          r={R_HOUSING}
          fill={`url(#${ids.bezelMetal})`}
          stroke="oklch(0.30 0.012 255)"
          strokeWidth="1.5"
        />
        <circle
          cx={C}
          cy={C}
          r={R_BEZEL_RIM}
          fill="none"
          stroke="var(--accent-soft)"
          strokeWidth="1"
        />

        {housingNotches.map((n, i) => (
          <line
            key={i}
            x1={n.x1}
            y1={n.y1}
            x2={n.x2}
            y2={n.y2}
            stroke="var(--accent)"
            strokeOpacity={n.major ? 0.55 : 0.18}
            strokeWidth={n.major ? 1.2 : 0.7}
          />
        ))}

        {screws.map((s, i) => (
          <g key={i}>
            <circle
              cx={s.x}
              cy={s.y}
              r="3.6"
              fill="oklch(0.22 0.012 255)"
              stroke="var(--accent-soft)"
              strokeWidth="0.8"
            />
            <line
              x1={s.x + Math.cos(s.slot) * 2.4}
              y1={s.y + Math.sin(s.slot) * 2.4}
              x2={s.x - Math.cos(s.slot) * 2.4}
              y2={s.y - Math.sin(s.slot) * 2.4}
              stroke="oklch(0.10 0.012 255)"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </g>
        ))}

        {bezelMarks.map((m, i) => (
          <g key={i} transform={`translate(${m.x} ${m.y}) rotate(${m.rot})`}>
            <rect x={-1.2} y={-4} width={2.4} height={8} fill="var(--accent)" opacity="0.85" />
          </g>
        ))}

        <g style={{ transformOrigin: `${C}px ${C}px`, animation: "core-rotate-slow 60s linear infinite" }}>
          {apertureBlades.map((b, i) => (
            <g key={i}>
              <path
                d={b.d}
                fill={`url(#${ids.bladeGrad})`}
                stroke="oklch(0.08 0.012 255)"
                strokeWidth="0.8"
              />
              <path
                d={b.edge}
                stroke="var(--accent)"
                strokeWidth="1.4"
                opacity="0.85"
                strokeLinecap="round"
              />
            </g>
          ))}
        </g>

        <circle cx={C} cy={C} r={R_IRIS_OUT} fill={`url(#${ids.irisBand})`} />
        <circle
          cx={C}
          cy={C}
          r={R_IRIS_OUT}
          fill="none"
          stroke="var(--accent-glow)"
          strokeWidth="1.8"
          opacity={0.72 + env * 0.18}
        />
        <circle
          cx={C}
          cy={C}
          r={R_IRIS_OUT - 2}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="0.6"
          opacity="0.5"
        />

        <g style={{ transformOrigin: `${C}px ${C}px`, animation: "core-rotate-rev 120s linear infinite" }}>
          {irisSpokes.map((s, i) => (
            <line
              key={i}
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              stroke="var(--accent)"
              strokeOpacity={s.op}
              strokeWidth="0.7"
            />
          ))}
        </g>

        <circle
          cx={C + pupilDX}
          cy={C + pupilDY}
          r={R_IRIS_BAND_IN * 0.95}
          fill={`url(#${ids.pupilGlow})`}
          filter={`url(#${ids.pupilBloom})`}
          opacity={(0.85 + env * 0.12) * expressionGlow}
        />
        <circle
          cx={C + pupilDX}
          cy={C + pupilDY}
          r={R_IRIS_BAND_IN * 0.78}
          fill="none"
          stroke="var(--accent-glow)"
          strokeWidth="2.2"
          opacity={resolvedExpression === "concerned" ? 0.72 : 0.95}
        />
        <circle
          cx={C + pupilDX}
          cy={C + pupilDY}
          r={R_IRIS_BAND_IN * 0.78 - 3}
          fill="none"
          stroke="oklch(0.10 0.012 255)"
          strokeWidth="1.5"
        />
        <circle
          cx={C + pupilDX}
          cy={C + pupilDY}
          r={R_IRIS_BAND_IN * 0.62 * pupilBloom}
          fill={`url(#${ids.pupilCore})`}
          filter={`url(#${ids.pupilBloom})`}
        />
        <circle
          cx={C + pupilDX}
          cy={C + pupilDY}
          r={R_IRIS_BAND_IN * 0.22 * pupilBloom}
          fill="#fff8e8"
          opacity="0.95"
          filter={`url(#${ids.pupilBloom})`}
        />
        <circle
          cx={C + pupilDX}
          cy={C + pupilDY}
          r={R_IRIS_BAND_IN * 0.08 * pupilBloom}
          fill="#ffffff"
          opacity="1"
        />

        <path
          d={glintPath}
          stroke="#fff8e8"
          strokeWidth="5"
          fill="none"
          opacity={resolvedExpression === "concerned" ? 0.58 : 0.85}
          strokeLinecap="round"
        />
        <path
          d={glintPath}
          stroke="var(--accent-glow)"
          strokeWidth="10"
          fill="none"
          opacity="0.35"
          strokeLinecap="round"
        />
        <path
          d={describeArc(C, C, R_IRIS_OUT - 16, glintStart + 60, glintStart + 75)}
          stroke="#fff8e8"
          strokeWidth="2.5"
          fill="none"
          opacity="0.7"
          strokeLinecap="round"
        />

        <g
          style={{
            opacity: eyelidOpacity,
            transition: "opacity 300ms ease",
          }}
        >
          <path
            d={describeArc(C, C - size * 0.01, R_IRIS_OUT - 10, 250, 110)}
            stroke={resolvedExpression === "concerned" ? "oklch(0.72 0.12 35)" : "var(--accent-glow)"}
            strokeWidth={resolvedExpression === "concerned" ? 9 : 5}
            strokeLinecap="round"
            fill="none"
          />
          <path
            d={describeArc(C, C + size * 0.05, R_IRIS_OUT - 18, 68, 112)}
            stroke="oklch(0.10 0.012 255)"
            strokeWidth={resolvedExpression === "concerned" ? 8 : 4}
            strokeLinecap="round"
            fill="none"
          />
        </g>

        <g style={{ opacity: mode === "speaking" ? 1 : 0, transition: "opacity .4s ease-out" }}>
          {Array.from({ length: 28 }).map((_, i) => {
            const N = 28
            const startAng = 210
            const endAng = 330
            const ang = ((startAng + (i / (N - 1)) * (endAng - startAng)) * Math.PI) / 180
            const r = R_APERTURE_IN - 4
            const phaseOffset = i / N
            const amp = Math.max(
              0.15,
              env * (0.5 + 0.5 * Math.sin(phase * 14 + phaseOffset * 9))
            )
            const len = 4 + amp * 18
            return (
              <line
                key={i}
                x1={C + Math.cos(ang) * r}
                y1={C + Math.sin(ang) * r}
                x2={C + Math.cos(ang) * (r - len)}
                y2={C + Math.sin(ang) * (r - len)}
                stroke="var(--accent-glow)"
                strokeWidth="1.6"
                strokeOpacity={0.9}
                strokeLinecap="round"
              />
            )
          })}
        </g>
      </svg>
    </div>
  )
}
