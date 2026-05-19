import type { DetailedHTMLProps, HTMLAttributes } from "react"

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "elevenlabs-convai": DetailedHTMLProps<
        HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        "agent-id"?: string
        "signed-url"?: string
        variant?: string
        "action-text"?: string
        "start-call-text"?: string
        "listening-text"?: string
        "speaking-text"?: string
        "dynamic-variables"?: string
      }
    }
  }
}
