import type { OperationsBusiness } from "@/types/operations"

export type ClassifiedBusiness = OperationsBusiness | "Unassigned"

const DINBNB_MARKERS = [
  "dinbnb",
  "lev",
  "oslo",
  "bergen",
  "guesty",
  "hostaway",
  "pricelabs",
  "kg-",
  "emil",
  "jonas",
  "kasper",
  "nameda",
  "diana",
  "king emmanuel",
  "get team",
  "rob",
  "gerson",
  "jane",
  "apartment hotel",
]

const STAY_MINTY_MARKERS = [
  "stay minty",
  "stayminty",
  "smoky",
  "smokies",
  "nashville",
  "glamp",
  "dunn's creek",
  "dunns creek",
  "stellara",
  "evermere",
  "meredith",
  "kelli",
  "reveen",
  "jessica",
  "eric",
  "andy",
  "sean",
  "brandi",
  "shiela",
  "skie",
  "trackpms",
  "operto",
]

export function normalizeBusiness(value: unknown): ClassifiedBusiness {
  if (value === "Stay Minty" || value === "Dinbnb" || value === "Personal") {
    return value
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim()
    if (lower === "stayminty" || lower === "stay minty") return "Stay Minty"
    if (lower === "dinbnb") return "Dinbnb"
    if (lower === "personal") return "Personal"
  }
  return "Unassigned"
}

export function businessFromText(text: string): ClassifiedBusiness {
  const lower = text.toLowerCase()
  if (DINBNB_MARKERS.some((marker) => lower.includes(marker))) return "Dinbnb"
  if (STAY_MINTY_MARKERS.some((marker) => lower.includes(marker))) {
    return "Stay Minty"
  }
  return "Unassigned"
}

export function businessMatches(
  itemBusiness: ClassifiedBusiness,
  activeBusiness: ClassifiedBusiness
) {
  return (
    itemBusiness !== "Unassigned" &&
    activeBusiness !== "Unassigned" &&
    itemBusiness === activeBusiness
  )
}
