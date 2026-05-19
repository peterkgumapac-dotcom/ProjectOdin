interface ValknutProps {
  size?: number
  className?: string
  stroke?: string
  strokeWidth?: number
}

/**
 * Valknut — three interlocking triangles. Norse symbol associated with Odin.
 * Rendered as flat line work, not filled.
 */
export function Valknut({
  size = 28,
  className,
  stroke = "currentColor",
  strokeWidth = 1.25,
}: ValknutProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Upper triangle */}
      <path
        d="M32 6 L52 40 L12 40 Z"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      {/* Lower-left triangle */}
      <path
        d="M22 22 L8 56 L42 56 Z"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      {/* Lower-right triangle */}
      <path
        d="M42 22 L56 56 L22 56 Z"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </svg>
  )
}
