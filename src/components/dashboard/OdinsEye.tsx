import { motion } from "framer-motion"
import { Button } from "@/components/ui/button"

interface OdinsEyeProps {
  active?: boolean
  onAwaken: () => void
}

export function OdinsEye({ active = false, onAwaken }: OdinsEyeProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-10 select-none">
      <div className="label-track text-tertiary mb-6">ODIN'S EYE</div>

      <div className="relative w-[280px] h-[280px] flex items-center justify-center">
        {/* Outer ring */}
        <motion.div
          className="absolute inset-0 rounded-full border border-gold/30"
          animate={{ rotate: 360 }}
          transition={{ duration: 20, ease: "linear", repeat: Infinity }}
        >
          <span className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-gold/80" />
          <span className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-0.5 h-0.5 rounded-full bg-gold/60" />
        </motion.div>

        {/* Middle ring */}
        <motion.div
          className="absolute inset-6 rounded-full border border-frost/40"
          animate={{ rotate: -360 }}
          transition={{ duration: 12, ease: "linear", repeat: Infinity }}
        >
          <span className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-0.5 rounded-full bg-frost" />
        </motion.div>

        {/* Inner sphere (iris) */}
        <motion.div
          className="absolute inset-14 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 50% 45%, #d4b876 0%, #c9a961 22%, #6b5a3a 55%, #1a1a2e 92%)",
            boxShadow:
              "0 0 60px -10px rgba(201,169,97,0.55), inset 0 0 30px rgba(0,0,0,0.6)",
          }}
          animate={{ scale: [1, 1.04, 1] }}
          transition={{ duration: 2, ease: "easeInOut", repeat: Infinity }}
        >
          {/* Pupil */}
          <motion.div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-[#06080d]"
            style={{
              boxShadow: "inset 0 0 12px rgba(201,169,97,0.4)",
            }}
            animate={{ scale: active ? [1, 1.15, 1] : [1, 1.06, 1] }}
            transition={{
              duration: active ? 0.8 : 2.2,
              ease: "easeInOut",
              repeat: Infinity,
            }}
          />
        </motion.div>
      </div>

      <div className="mt-8 flex flex-col items-center gap-4">
        <span className="font-display text-base tracking-[0.3em] text-foreground">
          {active ? "ODIN LISTENS" : "ODIN OBSERVES"}
        </span>

        <Button
          onClick={onAwaken}
          className="rounded-full px-6 py-2 bg-gold/10 hover:bg-gold/20 border border-gold/40 text-gold gold-glow font-display tracking-[0.25em] text-xs"
          variant="ghost"
        >
          AWAKEN
        </Button>

        <svg
          viewBox="0 0 200 16"
          className="w-40 h-3 text-gold/60"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        >
          <polyline points="0,8 12,8 16,4 20,12 24,6 32,10 40,8 56,8 60,3 64,13 68,7 84,8 90,5 96,11 102,8 120,8 124,4 130,12 136,8 156,8 162,6 168,10 200,8" />
        </svg>
      </div>
    </div>
  )
}
