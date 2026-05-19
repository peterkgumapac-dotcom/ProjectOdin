import { useEffect, useRef, useState, type FormEvent } from "react"
import { Mic, MicOff, Send } from "lucide-react"
import { Valknut } from "./Valknut"

interface CommandBarProps {
  onSubmit: (text: string) => void
  onWake?: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognition

interface SpeechRecognitionEventResult {
  readonly isFinal: boolean
  readonly 0: { readonly transcript: string }
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: {
    readonly length: number
    readonly [index: number]: SpeechRecognitionEventResult
  }
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onend: (() => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  start: () => void
  stop: () => void
}

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  const win = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null
}

function hasWakePhrase(text: string): boolean {
  return /\b(hey|hi|okay|ok)\s+odin\b/i.test(text)
}

export function CommandBar({ onSubmit, onWake }: CommandBarProps) {
  const [text, setText] = useState("")
  const [focused, setFocused] = useState(false)
  const [wakeEnabled, setWakeEnabled] = useState(false)
  const [wakeSupported, setWakeSupported] = useState(false)
  const [wakeStatus, setWakeStatus] = useState<"idle" | "listening" | "blocked">(
    "idle"
  )
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const shouldListenRef = useRef(false)

  const handle = (e: FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    onSubmit(t)
    setText("")
  }

  useEffect(() => {
    setWakeSupported(Boolean(getSpeechRecognition()))
  }, [])

  useEffect(() => {
    shouldListenRef.current = wakeEnabled
    if (!wakeEnabled || !wakeSupported) {
      recognitionRef.current?.stop()
      recognitionRef.current = null
      if (!wakeEnabled) setWakeStatus("idle")
      return
    }

    const Recognition = getSpeechRecognition()
    if (!Recognition) return
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = "en-US"
    recognitionRef.current = recognition

    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index]?.[0]?.transcript ?? ""
        if (hasWakePhrase(transcript)) {
          onWake?.()
          setWakeStatus("idle")
          shouldListenRef.current = false
          setWakeEnabled(false)
          recognition.stop()
          break
        }
      }
    }

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setWakeStatus("blocked")
        setWakeEnabled(false)
        shouldListenRef.current = false
      }
    }

    recognition.onend = () => {
      if (!shouldListenRef.current) return
      window.setTimeout(() => {
        try {
          recognition.start()
          setWakeStatus("listening")
        } catch {
          // Browser may already be restarting recognition.
        }
      }, 300)
    }

    try {
      recognition.start()
      setWakeStatus("listening")
    } catch {
      setWakeStatus("blocked")
      setWakeEnabled(false)
    }

    return () => {
      shouldListenRef.current = false
      recognition.stop()
    }
  }, [onWake, wakeEnabled, wakeSupported])

  const toggleWake = () => {
    setWakeEnabled((current) => !current)
  }

  return (
    <footer
      className="h-16 w-full border-t border-border/60 bg-background/60 backdrop-blur-xl flex items-center px-6 gap-4"
      style={{ gridArea: "command" }}
    >
      <div className="text-gold/60">
        <Valknut size={20} stroke="currentColor" />
      </div>

      <button
        type="button"
        onClick={toggleWake}
        disabled={!wakeSupported}
        title={
          wakeSupported
            ? "Listen for 'Hey ODIN' while this dashboard is open"
            : "Wake phrase is not supported in this browser"
        }
        className={[
          "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors",
          wakeEnabled
            ? "border-gold/40 bg-gold/15 text-gold"
            : "border-border/70 bg-surface/50 text-tertiary hover:text-gold",
          !wakeSupported ? "cursor-not-allowed opacity-50" : "",
        ].join(" ")}
      >
        {wakeEnabled ? <Mic size={14} /> : <MicOff size={14} />}
        {wakeEnabled
          ? "Hey ODIN: on"
          : wakeStatus === "blocked"
            ? "Mic blocked"
            : "Hey ODIN"}
      </button>

      <form
        onSubmit={handle}
        className={[
          "flex-1 flex items-center gap-3 rounded-md border bg-surface/60 px-4 py-2 transition-all duration-300",
          focused
            ? "border-gold/60 gold-glow"
            : "border-border hover:border-border-accent",
        ].join(" ")}
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Speak to ODIN..."
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-tertiary outline-none font-sans"
          autoComplete="off"
        />
        <button
          type="submit"
          aria-label="Send command to ODIN"
          disabled={!text.trim()}
          className={[
            "w-8 h-8 rounded-full flex items-center justify-center transition-colors",
            text.trim()
              ? "text-gold bg-gold/10 hover:bg-gold/20"
              : "text-tertiary/50 cursor-not-allowed",
          ].join(" ")}
        >
          <Send size={15} />
        </button>
      </form>
    </footer>
  )
}
