type ConnectionTone = "connected" | "attention" | "disconnected"

interface ConnectionStatusChipProps {
  label: string
  tone: ConnectionTone
  detail?: string
  className?: string
}

function toneClasses(tone: ConnectionTone): string {
  if (tone === "connected") {
    return "border-[#75dc83]/45 bg-[#75dc83]/12 text-[#2f6c39]"
  }
  if (tone === "attention") {
    return "border-[#e0a24d]/45 bg-[#fff3dd] text-[#7d5a21]"
  }
  return "border-[#d07f58]/45 bg-[#fff0ea] text-[#8f3f1e]"
}

export function ConnectionStatusChip({
  label,
  tone,
  detail,
  className = "",
}: ConnectionStatusChipProps) {
  return (
    <span
      className={[
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em]",
        toneClasses(tone),
        className,
      ].join(" ")}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-85" />
      <span>{label}</span>
      {detail ? <span className="normal-case opacity-75">{detail}</span> : null}
    </span>
  )
}
