import { describe, expect, it } from 'vitest'
import { Arena } from '../src/game/arena'
import { CONFIG } from '../src/game/config'
import { Grid } from '../src/game/grid'
import { daySeed } from '../src/game/rng'
import { composeScore, territoryBp } from '../src/game/rules'
import { RULES, maxTerritoryBp, validateSubmission, cleanDisplayName } from '../server/validate.mjs'

const STEP = 1 / 60

/** Scripted player: repeatedly draws a square loop out of its territory. */
function loopPilot(a: Arena, size: number) {
  let leg = 0
  let legTime = 0
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  return () => {
    const p = a.player
    if (!p.outside) {
      legTime += STEP
      if (legTime > 0.5) {
        leg = (leg + 1) % 4
        legTime = 0
      }
    } else {
      legTime += STEP
      if (legTime > size / CONFIG.player.speed) {
        leg = (leg + 1) % 4
        legTime = 0
      }
    }
    const [x, z] = dirs[leg]
    a.playerInput = { x, z, boost: false }
  }
}

function play(seed: number, pilot = true) {
  const a = new Arena(seed, true)
  const drive = pilot ? loopPilot(a, 5) : () => undefined
  let reason: 'time' | 'cut' | 'wiped' = 'time'
  let firstCapture = -1
  let aiKills = 0
  while (a.time < CONFIG.round.seconds) {
    drive()
    for (const ev of a.step(STEP)) {
      if (ev.type === 'capture' && ev.id === 0 && firstCapture < 0) firstCapture = a.time
      if (ev.type === 'kill' && ev.killer !== 0) aiKills += 1
    }
    if (!a.player.alive) {
      reason = a.player.deathReason ?? 'cut'
      break
    }
  }
  return { a, result: a.result(reason), firstCapture, aiKills }
}

describe('grid', () => {
  it('captures a closed loop and everything it encloses', () => {
    const g = new Grid(20)
    g.claimDisk(0, 5.5, 5.5, 1.2)
    const trail: number[] = []
    // Up from (5,6) to (5,10), right to (10,10), down to (10,5), left back to (7,5).
    for (let z = 7; z <= 10; z += 1) trail.push(g.index(5, z))
    for (let x = 6; x <= 10; x += 1) trail.push(g.index(x, 10))
    for (let z = 9; z >= 5; z -= 1) trail.push(g.index(10, z))
    for (let x = 9; x >= 7; x -= 1) trail.push(g.index(x, 5))
    for (const c of trail) g.trail[c] = 0
    g.capture(0, trail)
    expect(g.owner[g.index(8, 8)]).toBe(0)
    expect(g.owner[g.index(12, 12)]).toBe(-1)
    expect(g.counts[0]).toBeGreaterThanOrEqual(30)
    expect(trail.every(c => g.trail[c] === -1)).toBe(true)
  })
  it('steals enclosed rival territory and clears owners', () => {
    const g = new Grid(20)
    g.claimDisk(1, 10.5, 10.5, 1)
    for (let x = 7; x <= 14; x += 1) for (let z = 7; z <= 14; z += 1) if (x === 7 || x === 14 || z === 7 || z === 14) g.owner[g.index(x, z)] = 0
    g.counts[0] = 28
    g.capture(0, [])
    expect(g.counts[1]).toBe(0)
    expect(g.owner[g.index(10, 10)]).toBe(0)
    expect(g.clearOwner(0).length).toBe(64)
    expect(g.counts[0]).toBe(0)
  })
})

describe('arena', () => {
  it('is deterministic for the daily seed', () => {
    const a = play(daySeed('2026-09-26'))
    const b = play(daySeed('2026-09-26'))
    expect(a.result).toEqual(b.result)
    const c = new Arena(daySeed('2026-09-27'), true)
    const d = new Arena(daySeed('2026-09-26'), true)
    expect(c.entities.map(e => e.personality + e.x.toFixed(3))).not.toEqual(d.entities.map(e => e.personality + e.x.toFixed(3)))
  })
  it('has both timid and aggressive rivals every day', () => {
    for (let i = 0; i < 20; i += 1) {
      const kinds = new Arena(daySeed(`2026-10-${String(i + 1).padStart(2, '0')}`), true).entities.map(e => e.personality)
      expect(kinds.filter(k => k === 'timid').length).toBeGreaterThanOrEqual(2)
      expect(kinds.filter(k => k === 'aggressive').length).toBeGreaterThanOrEqual(2)
      expect(kinds[0]).toBe('player')
    }
  })
  it('gives a simple looping player a first score within 10 seconds', () => {
    for (let i = 0; i < 12; i += 1) {
      const { firstCapture } = play(daySeed(`2026-11-${String(i + 1).padStart(2, '0')}`))
      expect(firstCapture).toBeGreaterThan(0)
      expect(firstCapture).toBeLessThan(10)
    }
  })
  it('AIs compete: they capture, cut each other and respawn', () => {
    const a = new Arena(12345, false)
    let kills = 0
    let captures = 0
    let respawns = 0
    while (a.time < 90) {
      for (const ev of a.step(STEP)) {
        if (ev.type === 'kill') kills += 1
        if (ev.type === 'capture') captures += 1
        if (ev.type === 'respawn') respawns += 1
      }
    }
    expect(captures).toBeGreaterThan(20)
    expect(kills).toBeGreaterThan(0)
    expect(respawns).toBeGreaterThan(0)
    const owned = a.entities.reduce((s, e) => s + a.grid.counts[e.id], 0)
    expect(owned).toBe(a.grid.owner.filter(o => o >= 0).length)
  })
  it('produces results the server accepts, across many seeded runs', () => {
    for (let i = 0; i < 30; i += 1) {
      const { result } = play(daySeed(`2027-01-${String(i + 1).padStart(2, '0')}`))
      expect(result.score).toBe(composeScore(result))
      const payload = { score: result.score, durationMs: result.durationMs, territoryBp: result.territoryBp, kills: result.kills, comboBonus: result.comboBonus, captures: result.captures, survived: result.survived }
      expect(() => validateSubmission(payload, result.durationMs + 300)).not.toThrow()
    }
  })
})

describe('server rules', () => {
  it('mirror the client config', () => {
    expect(RULES.gridCells).toBe(CONFIG.grid.size ** 2)
    expect(RULES.roundMs).toBe(CONFIG.round.seconds * 1000)
    expect(RULES.killBonus).toBe(CONFIG.score.killBonus)
    expect(RULES.surviveBonus).toBe(CONFIG.score.surviveBonus)
    expect(RULES.comboStep).toBe(CONFIG.score.comboStep)
    expect(RULES.comboCap).toBe(CONFIG.score.comboCap)
    expect(RULES.maxSpeed).toBeGreaterThan(CONFIG.player.speed * (1 + (CONFIG.player.boostMul - 1) * 0.3))
    const g = new Grid(CONFIG.grid.size)
    expect(RULES.startCells).toBeGreaterThanOrEqual(g.claimDisk(0, 30.5, 30.5, CONFIG.start.radius).length)
  })
  it('rejects implausible submissions', () => {
    const ok = { score: 2100, durationMs: 60000, territoryBp: 1500, kills: 2, comboBonus: 0, captures: 5, survived: false }
    expect(validateSubmission(ok, 61000)).toBe(true)
    expect(() => validateSubmission({ ...ok, score: 2101 }, 61000)).toThrow('score_mismatch')
    expect(() => validateSubmission(ok, 30000)).toThrow('duration_exceeds_run')
    expect(() => validateSubmission({ ...ok, durationMs: 200000 }, 300000)).toThrow('duration_outside_rules')
    expect(() => validateSubmission({ ...ok, territoryBp: 9000, score: 9600, durationMs: 5000 }, 6000)).toThrow('territory_implausible')
    expect(() => validateSubmission({ ...ok, survived: true, score: 2600 }, 61000)).toThrow('survival_implausible')
    expect(() => validateSubmission({ ...ok, comboBonus: 5000, score: 7100 }, 61000)).toThrow('combo_outside_rules')
    expect(maxTerritoryBp(90000)).toBe(10000)
    expect(territoryBp(3600, 3600)).toBe(10000)
  })
  it('cleans nicknames', () => {
    expect(cleanDisplayName('  小明  ')).toBe('小明')
    expect(cleanDisplayName('')).toBeNull()
    expect(cleanDisplayName('<script>')).toBeNull()
    expect(cleanDisplayName('a'.repeat(17))).toBeNull()
  })
})
