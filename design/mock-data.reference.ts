export type DayHours = { date: string; hours: number }

// Deterministic pseudo-random mock: ~14 months of daily hours
function mulberry32(a: number) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeMockDays(): DayHours[] {
  const rnd = mulberry32(42)
  const out: DayHours[] = []
  const end = new Date("2026-08-19T00:00:00")
  const start = new Date(end)
  start.setDate(start.getDate() - 370)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay()
    const weekend = dow === 0 || dow === 6
    const r = rnd()
    let hours = 0
    if (weekend) hours = r < 0.72 ? 0 : r * 4
    else hours = r < 0.06 ? 0 : 4 + r * 6.5
    out.push({
      date: d.toISOString().slice(0, 10),
      hours: Math.round(hours * 100) / 100,
    })
  }
  return out
}

export const MACHINES = [
  { id: "personal", label: "Personal laptop", hours: 12.4, share: 0.34 },
  { id: "work", label: "Work laptop", hours: 21.2, share: 0.58 },
  { id: "studio", label: "Studio mini", hours: 2.9, share: 0.08 },
]
