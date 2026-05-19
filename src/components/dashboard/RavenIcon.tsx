interface RavenIconProps {
  variant?: "huginn" | "muninn"
  size?: number
  className?: string
}

/**
 * Stylized raven silhouette. "huginn" (thought) faces left, "muninn" (memory)
 * faces right — implemented as a horizontal flip on the same path.
 */
export function RavenIcon({
  variant = "huginn",
  size = 22,
  className,
}: RavenIconProps) {
  const flip = variant === "muninn" ? "scale(-1, 1) translate(-32, 0)" : undefined
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <g transform={flip}>
        <path
          d="M6 19 C6 12 11 8 17 8 C22 8 25 11 26 14 L29 13 L26 17 C26 22 22 25 17 25 L11 25 C8 25 6 23 6 19 Z"
          fill="currentColor"
        />
        <path d="M11 25 L9 30 L13 26 Z" fill="currentColor" />
        <path d="M17 25 L17 30 L20 26 Z" fill="currentColor" />
        <circle cx="22" cy="14.5" r="1" fill="#0a0d14" />
      </g>
    </svg>
  )
}
