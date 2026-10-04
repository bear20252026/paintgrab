// Paint Grab score rules shared by the API (authoritative) and mirrored by src/game/rules.ts.
// A test asserts both sides use identical numbers. Change them only together with a new board id.
export const RULES = Object.freeze({
  boardId: 'paint-v1',
  rulesVersion: 'v1',
  gridCells: 64 * 64,
  startCells: 21,
  roundMs: 90_000,
  killBonus: 300,
  surviveBonus: 500,
  comboStep: 25,
  comboCap: 4,
  maxKills: 40,
  /** Upper bound for the player's cell speed including boost, in cells per second. */
  maxSpeed: 9,
})

export const MAX_COMBO_BONUS_PER_CAPTURE = RULES.comboStep * (RULES.comboCap - 1)
export const MAX_SCORE = 10_000 + RULES.maxKills * RULES.killBonus + 400 * MAX_COMBO_BONUS_PER_CAPTURE + RULES.surviveBonus

const reject = code => { throw Object.assign(new Error(code), { status: 422, code }) }
const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi

/** Final score from its parts; the client computes the same value. */
export function composeScore({ territoryBp, kills, comboBonus, survived }) {
  return territoryBp + kills * RULES.killBonus + comboBonus + (survived ? RULES.surviveBonus : 0)
}

/**
 * Largest territory (basis points) reachable after `durationMs` of play. A closed loop of length L
 * that leans on existing territory encloses at most L²/8 cells, so total captured area is bounded
 * by (v·t)²/8 plus the starting disc; the 1.5 factor absorbs stolen-territory corner cases.
 */
export function maxTerritoryBp(durationMs) {
  const t = Math.max(0, durationMs) / 1000
  const cells = RULES.startCells + 1.5 * (RULES.maxSpeed * t) ** 2 / 8
  return Math.min(10_000, Math.ceil((cells / RULES.gridCells) * 10_000))
}

/**
 * Validate a submitted run. `elapsedMs` is the server-measured time since the run was issued.
 * Throws a 422 with a specific code for anything implausible.
 */
export function validateSubmission(data, elapsedMs) {
  const { score, durationMs, territoryBp, kills, comboBonus, captures, survived } = data
  if (!int(durationMs, 1000, RULES.roundMs + 2000)) reject('duration_outside_rules')
  if (Number.isFinite(elapsedMs) && durationMs > elapsedMs + 5000) reject('duration_exceeds_run')
  if (!int(territoryBp, 0, 10_000)) reject('territory_outside_rules')
  if (!int(kills, 0, RULES.maxKills)) reject('kills_outside_rules')
  if (!int(captures, 0, 400)) reject('captures_outside_rules')
  if (!int(comboBonus, 0, captures * MAX_COMBO_BONUS_PER_CAPTURE)) reject('combo_outside_rules')
  if (typeof survived !== 'boolean') reject('invalid_survived')
  if (!int(score, 0, MAX_SCORE)) reject('score_outside_rules')
  const seconds = durationMs / 1000
  if (captures > Math.ceil(seconds * 1.5) + 1) reject('captures_implausible')
  if (kills > Math.floor(seconds / 2) + 1) reject('kills_implausible')
  if (survived && durationMs < RULES.roundMs - 1500) reject('survival_implausible')
  if (territoryBp > maxTerritoryBp(durationMs)) reject('territory_implausible')
  if (composeScore({ territoryBp, kills, comboBonus, survived }) !== score) reject('score_mismatch')
  return true
}

/** Nickname: 1–16 visible characters, no control or markup characters. */
export function cleanDisplayName(value) {
  if (typeof value !== 'string') return null
  const name = value.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (!name || [...name].length > 16) return null
  if (/[\u0000-\u001f\u007f-\u009f<>\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(name)) return null
  return name
}

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10)
}
