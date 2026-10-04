import { CONFIG } from './config'

/** Everything the server needs to verify a run (mirrors server/validate.mjs). */
export type RunSubmission = {
  score: number
  durationMs: number
  territoryBp: number
  kills: number
  comboBonus: number
  captures: number
  survived: boolean
}

export type EndReason = 'time' | 'cut' | 'wiped'

export type RunResult = RunSubmission & {
  reason: EndReason
  killer: { en: string; zh: string } | null
  /** Final placement among all arena entities by territory, 1-based. */
  place: number
  entrants: number
  bestCombo: number
  peakBp: number
}

/** Territory in basis points (1/100 of a percent), rounded down so it never overstates. */
export function territoryBp(cells: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(10_000, Math.floor((cells * 10_000) / total))
}

export function comboBonus(combo: number): number {
  const c = Math.min(Math.max(combo, 1), CONFIG.score.comboCap)
  return CONFIG.score.comboStep * (c - 1)
}

export function composeScore(p: Pick<RunSubmission, 'territoryBp' | 'kills' | 'comboBonus' | 'survived'>): number {
  return p.territoryBp + p.kills * CONFIG.score.killBonus + p.comboBonus + (p.survived ? CONFIG.score.surviveBonus : 0)
}

export function formatPct(bp: number): string {
  return `${(bp / 100).toFixed(1)}%`
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
