/**
 * Versioned local save. Everything the player keeps between sessions lives in one JSON record.
 * Corrupt or foreign data falls back to defaults instead of crashing.
 */
export type Locale = 'en' | 'zh-CN'
export type Quality = 'low' | 'medium' | 'high'

export type Guest = { id: string; token: string; name: string }

export type SaveData = {
  version: 2
  /** '' = never chosen; the game follows the browser language until the player picks one. */
  locale: Locale | ''
  musicVolume: number
  sfxVolume: number
  muted: boolean
  quality: Quality
  reducedMotion: boolean
  tutorialDone: boolean
  /** Leaderboard nickname; '' until the player enters one. */
  playerName: string
  bestScore: number
  bestBp: number
  /** Best score on `bestDay` (UTC). */
  dayBest: number
  bestDay: string
  runs: number
  guest: Guest | null
}

export const SAVE_KEY = 'paintgrab.save'

export function defaultSave(): SaveData {
  return {
    version: 2,
    locale: '',
    musicVolume: 0.6,
    sfxVolume: 0.85,
    muted: false,
    quality: 'high',
    reducedMotion: false,
    tutorialDone: false,
    playerName: '',
    bestScore: 0,
    bestBp: 0,
    dayBest: 0,
    bestDay: '',
    runs: 0,
    guest: null,
  }
}

const clamp01 = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)
const nonNegInt = (v: unknown, max = 1e7) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : 0)

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Printable letters, numbers, spaces and a few symbols; matches the server's allowed set loosely.
  const name = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f<>&"'`\\\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // Count code points like the server does, so emoji are never split.
  return [...name].slice(0, 16).join('').trim()
}

/** Parse untrusted stored JSON into a valid SaveData (pure; unit tested). */
export function parseSave(raw: string | null): SaveData {
  const base = defaultSave()
  if (!raw) return base
  let data: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
    data = parsed as Record<string, unknown>
  } catch {
    return base
  }
  if (data.version !== 2) return base
  const g = data.guest as Record<string, unknown> | null | undefined
  const guest = g && typeof g === 'object' && typeof g.id === 'string' && typeof g.token === 'string' && g.token.length > 10 ? { id: g.id, token: g.token, name: cleanName(g.name) } : null
  return {
    version: 2,
    locale: data.locale === 'en' || data.locale === 'zh-CN' ? data.locale : '',
    musicVolume: clamp01(data.musicVolume, base.musicVolume),
    sfxVolume: clamp01(data.sfxVolume, base.sfxVolume),
    muted: data.muted === true,
    quality: data.quality === 'low' || data.quality === 'medium' || data.quality === 'high' ? data.quality : base.quality,
    reducedMotion: data.reducedMotion === true,
    tutorialDone: data.tutorialDone === true,
    playerName: cleanName(data.playerName),
    bestScore: nonNegInt(data.bestScore, 100_000),
    bestBp: nonNegInt(data.bestBp, 10_000),
    dayBest: nonNegInt(data.dayBest, 100_000),
    bestDay: typeof data.bestDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.bestDay) ? data.bestDay : '',
    runs: nonNegInt(data.runs),
    guest,
  }
}

export class SaveStore {
  data: SaveData
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {
    let raw: string | null = null
    try {
      raw = this.storage?.getItem(SAVE_KEY) ?? null
    } catch {
      raw = null
    }
    this.data = parseSave(raw)
  }
  update(patch: Partial<SaveData>): void {
    this.data = { ...this.data, ...patch }
    try {
      this.storage?.setItem(SAVE_KEY, JSON.stringify(this.data))
    } catch {
      // Private browsing or quota: the game keeps working with in-memory settings.
    }
  }
  /** Record a finished run; returns whether it beat the all-time / today's best. */
  recordRun(score: number, bp: number, day: string): { allTime: boolean; today: boolean; previousBest: number } {
    const d = this.data
    const previousBest = d.bestScore
    const dayBest = d.bestDay === day ? d.dayBest : 0
    const allTime = score > d.bestScore
    const today = score > dayBest
    this.update({
      runs: d.runs + 1,
      bestScore: Math.max(d.bestScore, score),
      bestBp: Math.max(d.bestBp, bp),
      bestDay: day,
      dayBest: Math.max(dayBest, score),
    })
    return { allTime, today, previousBest }
  }
}
