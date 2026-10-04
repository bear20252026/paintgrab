import type { Arena, Entity, SteerInput } from './arena'
import { CONFIG, type PersonalityId } from './config'
import { range, type Rng } from './rng'

type AiPersonality = Exclude<PersonalityId, 'player'>
type Params = {
  out: [number, number]
  wide: [number, number]
  /** Head back home when a rival gets this close to the line. */
  danger: number
  /** Chase rival lines within this many cells. */
  hunt: number
  maxTrail: number
  speed: number
  enemyWeight: number
  dangerWeight: number
  /** <1 = prefers hunting the player. */
  playerBias: number
}

export const PERSONALITY: Record<AiPersonality, Params> = {
  timid: { out: [3, 6], wide: [4, 7], danger: 7.5, hunt: 3.5, maxTrail: 30, speed: 0.95, enemyWeight: 1.1, dangerWeight: 5, playerBias: 1 },
  greedy: { out: [5, 10], wide: [6, 11], danger: 6, hunt: 6, maxTrail: 46, speed: 1, enemyWeight: 1.6, dangerWeight: 2.5, playerBias: 0.9 },
  aggressive: { out: [6, 12], wide: [6, 11], danger: 4.8, hunt: 8, maxTrail: 52, speed: 1.05, enemyWeight: 2.3, dangerWeight: 1, playerBias: 0.7 },
}

type Mode = 'home' | 'out' | 'return' | 'hunt'
type Point = { x: number; z: number }

/**
 * One AI rival's decision making. Plans rectangular excursions out of its territory (size by
 * personality), bails out home when a rival threatens its line, and chases rival lines it can cut.
 * Everything scales with the match ramp so the last 30 seconds get noticeably more dangerous.
 */
export class Brain {
  readonly p: Params
  mode: Mode = 'home'
  private waypoints: Point[] = []
  private target: Point = { x: 0, z: 0 }
  private think = 0
  huntId = -1
  private huntTime = 0
  private wantBoost = false
  private huntCooldown = 0

  constructor(readonly personality: AiPersonality, private readonly rng: Rng) {
    this.p = PERSONALITY[personality]
  }

  get speedMul(): number {
    return this.p.speed
  }

  reset(): void {
    this.mode = 'home'
    this.waypoints = []
    this.huntId = -1
  }

  decide(e: Entity, a: Arena, dt: number): SteerInput {
    this.think -= dt
    this.huntTime += dt
    this.huntCooldown -= dt
    if (this.think <= 0) {
      this.think = 0.08 + this.rng() * 0.06
      this.replan(e, a)
    }
    const boost = this.wantBoost
    this.wantBoost = false
    return { x: this.target.x - e.x, z: this.target.z - e.z, boost }
  }

  private replan(e: Entity, a: Arena): void {
    const ramp = a.ramp
    const p = this.p
    const g = a.grid
    const n = a.size
    const inHome = g.owner[e.cell] === e.id
    if (inHome && this.mode !== 'out') {
      this.mode = 'home'
      this.huntId = -1
    }
    // Opportunistic line cutting, from home or on the way out.
    if (this.mode !== 'return' && this.mode !== 'hunt' && this.huntCooldown <= 0) {
      const prey = this.findPrey(e, a, p.hunt * (1 + 0.6 * ramp))
      const ownRisk = e.trail.length < 18 || this.personality === 'aggressive'
      if (prey !== null && ownRisk && this.rng() < (this.personality === 'timid' ? 0.08 : this.personality === 'greedy' ? 0.1 : 0.2)) {
        this.mode = 'hunt'
        this.huntId = prey
        this.huntTime = 0
      }
    }
    if (this.mode === 'hunt') {
      const prey = a.entities[this.huntId]
      const cell = prey && prey.alive ? this.nearestTrailCell(prey, e) : -1
      if (cell < 0 || this.huntTime > 5) {
        this.mode = inHome ? 'home' : 'return'
        this.huntCooldown = (this.personality === 'aggressive' ? 3 : 6) * (1 - 0.5 * ramp)
      } else {
        this.target = { x: (cell % n) + 0.5, z: Math.floor(cell / n) + 0.5 }
        const d = Math.hypot(this.target.x - e.x, this.target.z - e.z)
        if (d < 4 && this.personality === 'aggressive' && (prey.isPlayer || ramp > 0.4)) this.wantBoost = true
        return
      }
    }
    if (e.outside) {
      const threat = this.threat(e, a)
      const danger = p.danger * (1 - 0.3 * ramp)
      if (threat < danger || e.trail.length > p.maxTrail * (1 + 0.5 * ramp)) {
        this.mode = 'return'
        if (threat < 2.6) this.wantBoost = true
      }
    }
    if (this.mode === 'home') this.planExcursion(e, a)
    if (this.mode === 'out') {
      while (this.waypoints.length > 0 && Math.hypot(this.waypoints[0].x - e.x, this.waypoints[0].z - e.z) < 1.1) this.waypoints.shift()
      if (this.waypoints.length === 0) this.mode = e.outside ? 'return' : 'home'
      else this.target = this.waypoints[0]
    }
    if (this.mode === 'return') {
      if (!e.outside) {
        this.mode = 'home'
        this.planExcursion(e, a)
        return
      }
      const c = g.nearestOwned(e.id, e.x, e.z)
      if (c >= 0) this.target = { x: (c % n) + 0.5, z: Math.floor(c / n) + 0.5 }
    }
  }

  /** Closest distance from any living rival head to this entity's line or head. */
  private threat(e: Entity, a: Arena): number {
    const n = a.size
    let best = Infinity
    for (const o of a.entities) {
      if (o.id === e.id || !o.alive) continue
      // A rival sitting in its own territory is less of a threat than one roaming.
      const slack = o.outside ? 0 : 1.5
      for (let i = 0; i < e.trail.length; i += 2) {
        const c = e.trail[i]
        const d = Math.hypot((c % n) + 0.5 - o.x, Math.floor(c / n) + 0.5 - o.z) + slack
        if (d < best) best = d
      }
    }
    return best
  }

  private nearestTrailCell(prey: Entity, from: Entity): number {
    let best = -1
    let bestD = Infinity
    const n = CONFIG.grid.size
    for (const c of prey.trail) {
      const d = Math.hypot((c % n) + 0.5 - from.x, Math.floor(c / n) + 0.5 - from.z)
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    return best
  }

  private findPrey(e: Entity, a: Arena, radius: number): number | null {
    let best: number | null = null
    let bestScore = Infinity
    const n = a.size
    for (const o of a.entities) {
      if (o.id === e.id || !o.alive || o.trail.length === 0) continue
      if (o.isPlayer && a.playerControlled && a.time < CONFIG.ai.graceSeconds) continue
      let d = Infinity
      for (const c of o.trail) d = Math.min(d, Math.hypot((c % n) + 0.5 - e.x, Math.floor(c / n) + 0.5 - e.z))
      if (d >= radius) continue
      // Only chase lines we can reach before their owner gets home.
      const home = a.grid.nearestOwned(o.id, o.x, o.z)
      const homeD = home < 0 ? 99 : Math.hypot((home % n) + 0.5 - o.x, Math.floor(home / n) + 0.5 - o.z)
      if (d > homeD * (0.5 + 0.45 * a.ramp) + 0.5) continue
      const bias = o.isPlayer ? this.p.playerBias - 0.25 * a.ramp : 1
      const score = d * bias
      if (d < radius && score < bestScore) {
        bestScore = score
        best = o.id
      }
    }
    return best
  }

  private planExcursion(e: Entity, a: Arena): void {
    const g = a.grid
    const n = a.size
    const p = this.p
    const scale = 1 + 0.35 * a.ramp
    const lo = 1.5
    const hi = n - 1.5
    const clamp = (v: number) => Math.min(hi, Math.max(lo, v))
    let bestScore = -Infinity
    let best: Point[] | null = null
    const offset = this.rng() * Math.PI * 2
    for (let k = 0; k < 8; k += 1) {
      const ang = offset + (k / 8) * Math.PI * 2
      const dx = Math.cos(ang)
      const dz = Math.sin(ang)
      // Walk to the edge of our territory along this direction.
      let ex = e.x
      let ez = e.z
      let found = false
      for (let s = 0; s < 40; s += 1) {
        ex += dx * 0.7
        ez += dz * 0.7
        if (ex < lo || ez < lo || ex > hi || ez > hi) break
        if (g.owner[g.cellAt(ex, ez)] !== e.id) {
          found = true
          break
        }
      }
      if (!found) continue
      const out = range(this.rng, p.out[0], p.out[1]) * scale
      const wide = range(this.rng, p.wide[0], p.wide[1]) * scale
      const side = this.rng() < 0.5 ? 1 : -1
      const px = -dz * side
      const pz = dx * side
      const raw: Point[] = [
        { x: ex + dx * out, z: ez + dz * out },
        { x: ex + dx * out + px * wide, z: ez + dz * out + pz * wide },
        { x: ex + px * wide - dx * 1.2, z: ez + pz * wide - dz * 1.2 },
      ]
      const pts = raw.map(q => ({ x: clamp(q.x), z: clamp(q.z) }))
      const clipped = raw.some((q, i) => Math.abs(q.x - pts[i].x) + Math.abs(q.z - pts[i].z) > 1)
      // Value: sampled cells inside the loop rectangle.
      let value = 0
      for (let u = 0.5; u < out; u += 1.5) {
        for (let v = 0.5; v < wide; v += 1.5) {
          const sx = ex + dx * u + px * v
          const sz = ez + dz * u + pz * v
          if (sx < 0 || sz < 0 || sx >= n || sz >= n) continue
          const c = g.cellAt(sx, sz)
          const o = g.owner[c]
          if (o === e.id) continue
          value += o === -1 ? 1 : p.enemyWeight
          if (g.trail[c] >= 0 && g.trail[c] !== e.id) value += 2
        }
      }
      const cx = ex + dx * out * 0.5 + px * wide * 0.5
      const cz = ez + dz * out * 0.5 + pz * wide * 0.5
      let risk = 0
      for (const o of a.entities) {
        if (o.id === e.id || !o.alive) continue
        const d = Math.hypot(o.x - cx, o.z - cz)
        risk += Math.max(0, 12 - d) * (o.outside ? 1 : 0.5)
      }
      const score = value * (clipped ? 0.6 : 1) - risk * p.dangerWeight * (1 - 0.4 * a.ramp) + this.rng() * 4
      if (score > bestScore) {
        bestScore = score
        best = [{ x: clamp(ex + dx * 0.8), z: clamp(ez + dz * 0.8) }, ...pts]
      }
    }
    if (best) {
      this.waypoints = best
      this.mode = 'out'
      this.target = best[0]
    } else {
      // Boxed in: wander toward the middle.
      this.target = { x: n / 2 + range(this.rng, -8, 8), z: n / 2 + range(this.rng, -8, 8) }
    }
  }
}
