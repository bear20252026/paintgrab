/**
 * All gameplay tuning in one place. Scoring numbers mirror server/validate.mjs (a test asserts
 * they match); change both together with a new board id.
 */
export const CONFIG = {
  grid: { size: 64 },
  round: { seconds: 90 },
  player: {
    speed: 6.8,
    /** rad/s — high so keyboard turns feel instant but still draw a smooth curve. */
    turnRate: 11,
    boostMul: 1.65,
    boostTime: 0.7,
    boostCooldown: 3.5,
  },
  start: { radius: 2.6 },
  ai: {
    count: 5,
    baseSpeed: 6.2,
    turnRate: 7.5,
    respawn: 3,
    /** The AIs leave the player's line alone for the first seconds so a newcomer's first loop lands. */
    graceSeconds: 9,
    /** AI speed multiplier gained by the final second (linear ramp from 1). */
    rampSpeed: 0.2,
  },
  score: {
    killBonus: 300,
    surviveBonus: 500,
    comboStep: 25,
    comboCap: 4,
    comboWindow: 5,
    /** Captures smaller than this don't count as a capture for combos. */
    comboMinCells: 12,
  },
  /** Timeline beats (seconds left). */
  beats: { frenzy: 30, final: 10 },
} as const

export type PersonalityId = 'player' | 'timid' | 'aggressive' | 'greedy'
