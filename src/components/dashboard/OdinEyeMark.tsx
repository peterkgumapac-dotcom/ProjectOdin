export function OdinEyeMark({ className = "" }: { className?: string }) {
  return (
    <span className={`odin-eye-mark ${className}`} aria-hidden="true">
      <span className="odin-eye-mark__outer" />
      <span className="odin-eye-mark__ticks">
        {Array.from({ length: 28 }, (_, index) => (
          <span
            key={index}
            style={{ transform: `rotate(${(360 / 28) * index}deg)` }}
          />
        ))}
      </span>
      <span className="odin-eye-mark__iris" />
      <span className="odin-eye-mark__blade odin-eye-mark__blade-a" />
      <span className="odin-eye-mark__blade odin-eye-mark__blade-b" />
      <span className="odin-eye-mark__pupil" />
    </span>
  )
}
