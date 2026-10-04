import { Brain } from './ai'
import { CONFIG, type PersonalityId } from './config'
import { Grid, type CellChange } from './grid'
import { mulberry32, range, shuffle, type Rng } from './rng'
import { comboBonus, composeScore, territoryBp, type EndReason, type RunResult } from './rules'

export type Name = { en: string; zh: string }

export type Entity = {
  id: number
  name: Name
  color: string
  personality: PersonalityId
  isPlayer: boolean
  x: number
  z: number
  heading: number
  alive: boolean
  respawnIn: number
  cell: number
  outside: boolean
  /** Cells of the live trail, in drawing order. */
  trail: number[]
  /** Smooth world path of the live trail as flat [x, z, x, z…] for rendering. */
  path: number[]
  boostLeft: number
  boostCd: number
  speed: number
  kills: number
  captures: number
  combo: number
  comboTimer: number
  comboBonus: number
  bestCombo: number
  /** Territory cells at the moment of death (the score counts what you held). */
  deathCells: number
  killedBy: number
  deathReason: EndReason | null
  peakCells: number
}

export type ArenaEvent =
  | { type: 'capture'; id: number; changes: CellChange[]; gained: number; combo: number; bonus: number; x: number; z: number; closeCall: boolean }
  | { type: 'kill'; victim: number; killer: number; reason: 'cut' | 'wiped'; x: number; z: number; changes: CellChange[] }
  | { type: 'respawn'; id: number; changes: CellChange[] }
  | { type: 'leave'; id: number }
  | { type: 'boost'; id: number }
  | { type: 'nearMiss'; by: number; x: number; z: number }

export type SteerInput = { x: number; z: number; boost: boolean }

const PALETTE_PLAYER = '#ff4f7b'
const PALETTE_AI = ['#3fb2ff', '#3fd07a', '#ffa23a', '#9b6bff', '#ffd23f']
const NAMES: Record<Exclude<PersonalityId, 'player'>, Name[]> = {
  timid: [{ en: 'Pudding', zh: '布丁' }, { en: 'Mochi', zh: '麻薯' }, { en: 'Pebble', zh: '豆豆' }],
  aggressive: [{ en: 'Blaze', zh: '烈焰' }, { en: 'Rumble', zh: '莽莽' }, { en: 'Dart', zh: '飞镖' }],
  greedy: [{ en: 'Nibbles', zh: '贪贪' }, { en: 'Magpie', zh: '喜鹊' }],
}

/**
 * The whole match simulation, independent of rendering: a territory grid plus one player and
 * several AI rivals. `step()` advances by one fixed tick and returns what happened so the scene can
 * turn it into animation, sound and UI.
 */
export class Arena {
  readonly grid: Grid
  readonly entities: Entity[] = []
  readonly size: number
  time = 0
  playerInput: SteerInput = { x: 0, z: 0, boost: false }
  /** 0..1 threat to the player's trail (for the danger vignette/heartbeat). */
  danger = 0
  private readonly rng: Rng
  private readonly brains = new Map<number, Brain>()
  private readonly nearFlag: boolean[] = []
  private nearCooldown = 0
  private events: ArenaEvent[] = []

  constructor(seed: number, readonly playerControlled: boolean) {
    this.size = CONFIG.grid.size
    this.grid = new Grid(this.size)
    this.rng = mulberry32(seed)
    const n = this.size
    const personalities = shuffle(this.rng, ['timid', 'timid', 'aggressive', 'aggressive', this.rng() < 0.5 ? 'greedy' : this.rng() < 0.5 ? 'timid' : 'aggressive'] as Exclude<PersonalityId, 'player'>[])
    const colors = shuffle(this.rng, [...PALETTE_AI])
    const used = new Set<string>()
    const base = this.rng() * Math.PI * 2
    const total = CONFIG.ai.count + 1
    for (let i = 0; i < total; i += 1) {
      const a = base + (i / total) * Math.PI * 2 + range(this.rng, -0.18, 0.18)
      const r = n * range(this.rng, 0.27, 0.34)
      const x = n / 2 + Math.cos(a) * r
      const z = n / 2 + Math.sin(a) * r
      const isPlayer = i === 0 && playerControlled
      const personality: PersonalityId = isPlayer ? 'player' : i === 0 ? 'greedy' : personalities[i - 1]
      let name: Name = { en: 'You', zh: '你' }
      if (!isPlayer) {
        const pool = NAMES[personality as Exclude<PersonalityId, 'player'>].filter(nm => !used.has(nm.en))
        name = pool[Math.floor(this.rng() * pool.length)] ?? NAMES.greedy[0]
        used.add(name.en)
      }
      const e: Entity = {
        id: i, name, color: i === 0 ? PALETTE_PLAYER : colors[(i - 1) % colors.length], personality, isPlayer,
        x, z, heading: a + Math.PI + range(this.rng, -0.6, 0.6), alive: true, respawnIn: 0, cell: this.grid.cellAt(x, z), outside: false,
        trail: [], path: [], boostLeft: 0, boostCd: 0, speed: 0, kills: 0, captures: 0, combo: 0, comboTimer: 0, comboBonus: 0, bestCombo: 0,
        deathCells: 0, killedBy: -1, deathReason: null, peakCells: 0,
      }
      this.entities.push(e)
      this.grid.claimDisk(i, x, z, CONFIG.start.radius)
      if (!isPlayer) this.brains.set(i, new Brain(personality as Exclude<PersonalityId, 'player'>, mulberry32((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0)))
      this.nearFlag.push(false)
    }
  }

  get player(): Entity {
    return this.entities[0]
  }
  /** 0 at the start, 1 at the final second. */
  get ramp(): number {
    return Math.min(1, this.time / CONFIG.round.seconds)
  }
  get timeLeft(): number {
    return Math.max(0, CONFIG.round.seconds - this.time)
  }
  cellsOf(id: number): number {
    return this.grid.counts[id]
  }
  bpOf(id: number): number {
    return territoryBp(this.grid.counts[id], this.grid.total)
  }

  step(dt: number): ArenaEvent[] {
    this.events = []
    this.time += dt
    this.nearCooldown = Math.max(0, this.nearCooldown - dt)
    for (const e of this.entities) {
      if (!e.alive) {
        if (e.isPlayer && this.playerControlled) continue
        e.respawnIn -= dt
        if (e.respawnIn <= 0) this.tryRespawn(e)
        continue
      }
      this.moveEntity(e, dt)
      e.comboTimer = Math.max(0, e.comboTimer - dt)
      if (e.comboTimer <= 0) e.combo = 0
      e.peakCells = Math.max(e.peakCells, this.grid.counts[e.id])
    }
    if (this.playerControlled) this.updateDanger()
    return this.events
  }

  private moveEntity(e: Entity, dt: number): void {
    const brain = this.brains.get(e.id)
    const steer = brain ? brain.decide(e, this, dt) : this.playerInput
    const cfg = CONFIG.player
    if (steer.boost && e.boostCd <= 0) {
      e.boostLeft = cfg.boostTime
      e.boostCd = cfg.boostCooldown + cfg.boostTime
      this.events.push({ type: 'boost', id: e.id })
    }
    e.boostLeft = Math.max(0, e.boostLeft - dt)
    e.boostCd = Math.max(0, e.boostCd - dt)
    const base = brain ? CONFIG.ai.baseSpeed * brain.speedMul * (1 + CONFIG.ai.rampSpeed * this.ramp) : cfg.speed
    e.speed = base * (e.boostLeft > 0 ? cfg.boostMul : 1)
    const turnRate = brain ? CONFIG.ai.turnRate : cfg.turnRate
    if (Math.hypot(steer.x, steer.z) > 0.2) {
      const want = Math.atan2(steer.z, steer.x)
      let diff = want - e.heading
      diff = Math.atan2(Math.sin(diff), Math.cos(diff))
      const maxTurn = turnRate * dt
      e.heading += Math.max(-maxTurn, Math.min(maxTurn, diff))
      e.heading = Math.atan2(Math.sin(e.heading), Math.cos(e.heading))
    }
    const n = this.size
    const ox = e.x
    const oz = e.z
    let nx = ox + Math.cos(e.heading) * e.speed * dt
    let nz = oz + Math.sin(e.heading) * e.speed * dt
    const lo = 0.3
    const hi = n - 0.3
    if (nx < lo || nx > hi) {
      nx = Math.min(hi, Math.max(lo, nx))
      // Slide along the rail: keep only the along-wall component of the heading.
      e.heading = Math.sin(e.heading) >= 0 ? Math.PI / 2 : -Math.PI / 2
    }
    if (nz < lo || nz > hi) {
      nz = Math.min(hi, Math.max(lo, nz))
      e.heading = Math.cos(e.heading) >= 0 ? 0 : Math.PI
    }
    e.x = nx
    e.z = nz
    const cell = this.grid.cellAt(nx, nz)
    if (cell !== e.cell) {
      const cx0 = e.cell % n
      const cz0 = Math.floor(e.cell / n)
      const cx1 = cell % n
      const cz1 = Math.floor(cell / n)
      if (cx0 !== cx1 && cz0 !== cz1) {
        // Diagonal hop: visit the corner cell crossed first so trails stay 4-connected.
        const bx = cx1 > cx0 ? cx0 + 1 : cx0
        const bz = cz1 > cz0 ? cz0 + 1 : cz0
        const tx = Math.abs(nx - ox) > 1e-9 ? (bx - ox) / (nx - ox) : 1
        const tz = Math.abs(nz - oz) > 1e-9 ? (bz - oz) / (nz - oz) : 1
        const mid = tx < tz ? this.grid.index(cx1, cz0) : this.grid.index(cx0, cz1)
        this.enterCell(e, mid, ox, oz)
        if (!e.alive) return
      }
      this.enterCell(e, cell, ox, oz)
    }
    if (e.alive && e.outside) {
      const p = e.path
      const lx = p[p.length - 2]
      const lz = p[p.length - 1]
      if (p.length < 2 || Math.hypot(nx - lx, nz - lz) > 0.32) p.push(nx, nz)
    }
  }

  private enterCell(e: Entity, cell: number, fromX: number, fromZ: number): void {
    e.cell = cell
    const g = this.grid
    const t = g.trail[cell]
    if (t >= 0 && t !== e.id) this.kill(t, e.id, 'cut')
    if (!e.alive) return
    if (g.owner[cell] === e.id) {
      if (e.outside) {
        e.outside = false
        if (e.trail.length > 0) this.capture(e)
        e.path = []
      }
      return
    }
    if (!e.outside) {
      e.outside = true
      e.path = [fromX, fromZ]
      this.events.push({ type: 'leave', id: e.id })
    }
    if (g.trail[cell] !== e.id) {
      g.trail[cell] = e.id
      e.trail.push(cell)
    }
  }

  private capture(e: Entity): void {
    const changes = this.grid.capture(e.id, e.trail)
    e.trail = []
    const gained = changes.length
    let combo = 0
    let bonus = 0
    if (gained >= CONFIG.score.comboMinCells) {
      e.captures += 1
      e.combo = e.comboTimer > 0 ? e.combo + 1 : 1
      e.comboTimer = CONFIG.score.comboWindow
      combo = e.combo
      bonus = comboBonus(combo)
      e.comboBonus += bonus
      e.bestCombo = Math.max(e.bestCombo, combo)
    }
    let closeCall = false
    if (e.isPlayer) {
      for (const o of this.entities) {
        if (o.id !== e.id && o.alive && Math.hypot(o.x - e.x, o.z - e.z) < 2.6) closeCall = true
      }
    }
    this.events.push({ type: 'capture', id: e.id, changes, gained, combo, bonus, x: e.x, z: e.z, closeCall })
    const hit = new Set(changes.map(c => c.prev).filter(p => p >= 0))
    for (const v of hit) {
      const victim = this.entities[v]
      if (victim.alive && this.grid.counts[v] === 0) this.kill(v, e.id, 'wiped')
    }
  }

  private kill(victimId: number, killerId: number, reason: 'cut' | 'wiped'): void {
    const v = this.entities[victimId]
    if (!v.alive) return
    v.deathCells = this.grid.counts[victimId]
    v.alive = false
    v.killedBy = killerId
    v.deathReason = reason
    this.grid.clearTrail(v.id, v.trail)
    v.trail = []
    v.path = []
    v.outside = false
    v.combo = 0
    v.respawnIn = CONFIG.ai.respawn
    const changes = this.grid.clearOwner(v.id)
    if (killerId >= 0 && killerId !== victimId) this.entities[killerId].kills += 1
    this.events.push({ type: 'kill', victim: victimId, killer: killerId, reason, x: v.x, z: v.z, changes })
  }

  private tryRespawn(e: Entity): void {
    const n = this.size
    const r = CONFIG.start.radius
    for (let i = 0; i < 40; i += 1) {
      const x = range(this.rng, 6, n - 6)
      const z = range(this.rng, 6, n - 6)
      if (!this.grid.diskFree(x, z, r)) continue
      if (this.entities.some(o => o.alive && Math.hypot(o.x - x, o.z - z) < 9)) continue
      e.x = x
      e.z = z
      e.heading = Math.atan2(n / 2 - z, n / 2 - x)
      e.alive = true
      e.cell = this.grid.cellAt(x, z)
      e.outside = false
      e.boostLeft = 0
      e.boostCd = 0
      const changes = this.grid.claimDisk(e.id, x, z, r)
      this.brains.get(e.id)?.reset()
      this.events.push({ type: 'respawn', id: e.id, changes })
      return
    }
    e.respawnIn = 0.5
  }

  private updateDanger(): void {
    const p = this.player
    let dmin = Infinity
    const n = this.size
    if (p.alive && p.outside && p.trail.length > 0) {
      for (const o of this.entities) {
        if (o.id === p.id || !o.alive) continue
        let d = Infinity
        for (let i = 0; i < p.trail.length; i += 1) {
          const c = p.trail[i]
          const dx = (c % n) + 0.5 - o.x
          const dz = Math.floor(c / n) + 0.5 - o.z
          const dd = dx * dx + dz * dz
          if (dd < d) d = dd
        }
        d = Math.sqrt(d)
        dmin = Math.min(dmin, d)
        if (d < 1.35) this.nearFlag[o.id] = true
        else if (this.nearFlag[o.id] && d > 2.8) {
          this.nearFlag[o.id] = false
          if (this.nearCooldown <= 0) {
            this.nearCooldown = 2.5
            this.events.push({ type: 'nearMiss', by: o.id, x: p.x, z: p.z })
          }
        }
      }
    } else {
      this.nearFlag.fill(false)
    }
    this.danger = dmin === Infinity ? 0 : Math.max(0, Math.min(1, 1 - (dmin - 1.2) / 6))
  }

  /** True when AI `id` is currently chasing the player's line (shown as a warning marker). */
  isHuntingPlayer(id: number): boolean {
    const b = this.brains.get(id)
    return !!b && b.mode === 'hunt' && b.huntId === 0 && this.playerControlled
  }

  personalityOf(id: number): string {
    return this.entities[id].personality
  }

  /** Live placement of `id` among living entities by territory (1-based). */
  placeOf(id: number): number {
    const mine = this.grid.counts[id]
    return 1 + this.entities.filter(o => o.id !== id && this.grid.counts[o.id] > mine).length
  }

  /** Final result for the player (call at death or time-out). */
  result(reason: EndReason): RunResult {
    const p = this.player
    const cells = p.alive ? this.grid.counts[0] : p.deathCells
    const bp = territoryBp(cells, this.grid.total)
    const survived = reason === 'time'
    const durationMs = Math.round(Math.min(this.time, CONFIG.round.seconds) * 1000)
    const parts = { territoryBp: bp, kills: p.kills, comboBonus: p.comboBonus, survived }
    const others = this.entities.filter(o => o.id !== 0)
    const place = 1 + others.filter(o => this.grid.counts[o.id] > cells).length
    const killer = p.killedBy >= 0 ? this.entities[p.killedBy] : undefined
    return {
      ...parts,
      score: composeScore(parts),
      durationMs,
      captures: p.captures,
      reason,
      killer: killer ? killer.name : null,
      place,
      entrants: this.entities.length,
      bestCombo: p.bestCombo,
      peakBp: territoryBp(Math.max(p.peakCells, cells), this.grid.total),
    }
  }
}
