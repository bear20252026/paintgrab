import * as THREE from 'three'
import type { Audio } from '../engine/audio'
import type { Input } from '../engine/input'
import type { Renderer } from '../engine/renderer'
import type { Quality } from '../engine/save'
import { Arena, type ArenaEvent, type Entity } from './arena'
import { Avatar } from './avatars'
import { BoardView } from './board'
import { FollowCamera } from './camera'
import { CONFIG } from './config'
import { Fx } from './fx'
import { composeScore, formatPct, type EndReason, type RunResult } from './rules'
import { TrailView } from './trails'
import { World } from './world'

export type Mode = 'attract' | 'playing' | 'paused' | 'dying' | 'ended'
export type PopupKind = 'capture' | 'combo' | 'kill' | 'danger' | 'record' | 'info' | 'big'

export type RivalInfo = { id: number; name: string; color: string; personality: string; bp: number; alive: boolean; respawnIn: number; hunting: boolean }

export type HudState = {
  timeLeft: number
  bp: number
  score: number
  combo: number
  comboFrac: number
  kills: number
  place: number
  outside: boolean
  danger: number
  boostReady: number
  rivals: RivalInfo[]
}

export type GameHooks = {
  popup: (text: string, screen: { x: number; y: number } | null, kind: PopupKind) => void
  banner: (key: string, kind: 'frenzy' | 'final' | 'big' | 'target' | 'record' | 'go') => void
  feed: (killer: { name: string; color: string } | null, victim: { name: string; color: string }, reason: 'cut' | 'wiped') => void
  flash: (kind: 'death' | 'kill' | 'capture') => void
  end: (result: RunResult) => void
  firstCapture: () => void
}

type Opts = { t: (k: string, v?: Record<string, string | number>) => string; lang: () => 'en' | 'zh' }

/**
 * Owns the three.js scene and one match. Gameplay rules live in Arena (pure); this class turns
 * arena events into animation, particles, sound, camera work and UI hooks.
 */
export class Game {
  mode: Mode = 'attract'
  reducedMotion = false
  arena: Arena
  private readonly world: World
  private readonly board: BoardView
  private readonly cam = new FollowCamera()
  private readonly fx: Fx
  private avatars: Avatar[] = []
  private trails: TrailView[] = []
  private warn: THREE.Sprite[] = []
  private prev: Array<{ x: number; z: number }> = []
  private lastPaths: number[][] = []
  /** Ownership just before the player's last step (their land is wiped on death). */
  private snapshot: Int8Array | null = null
  private readonly homeArrow: THREE.Mesh
  private readonly guide: THREE.InstancedMesh
  private guideOn = false
  private now = 0
  private hitstop = 0
  private slowmo = 0
  private dyingTimer = 0
  private pendingResult: RunResult | null = null
  private beatFrenzy = false
  private beatFinal = false
  private lastTick = 0
  private heartbeat = 0
  private nearestHome = -1
  private homeScan = 0
  private recordShown = false
  private targetShown = false
  private firstCaptureDone = false
  private readonly raycaster = new THREE.Raycaster()
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.5)
  private readonly ndc = new THREE.Vector2()
  private readonly hit = new THREE.Vector3()
  private readonly v = new THREE.Vector3()
  /** Score to beat (challenge link) and personal best, for live "passed it" moments. */
  targetScore = 0
  bestScore = 0
  tutorial = false

  constructor(private readonly renderer: Renderer, private readonly input: Input, private readonly audio: Audio, private readonly hooks: GameHooks, private readonly opts: Opts) {
    const size = CONFIG.grid.size
    this.world = new World(size, renderer.shadowMapSize)
    this.arena = new Arena((Math.random() * 2 ** 31) >>> 0, false)
    this.board = new BoardView(size, this.arena.entities.map(e => e.color))
    this.world.scene.add(this.board.mesh)
    this.fx = new Fx(size)
    this.world.scene.add(this.fx.group)
    const arrowGeo = new THREE.ConeGeometry(0.42, 1.1, 3)
    arrowGeo.rotateZ(-Math.PI / 2)
    this.homeArrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, toneMapped: false }))
    this.homeArrow.visible = false
    this.world.scene.add(this.homeArrow)
    this.guide = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, toneMapped: false }), 40)
    this.guide.visible = false
    this.guide.frustumCulled = false
    this.world.scene.add(this.guide)
    this.buildEntities()
    this.cam.attract(size, 0.016)
  }

  private get half(): number {
    return CONFIG.grid.size / 2
  }

  private nameOf(e: Entity): string {
    return e.isPlayer ? this.opts.t('you') : e.name[this.opts.lang()]
  }

  private buildEntities(): void {
    for (const a of this.avatars) {
      this.world.scene.remove(a.root)
      a.dispose()
    }
    for (const t of this.trails) this.world.scene.remove(t.mesh)
    this.avatars = []
    this.trails = []
    this.warn = []
    this.board.setPalette(this.arena.entities.map(e => e.color))
    this.board.reset(this.arena.grid.owner)
    for (const e of this.arena.entities) {
      const av = new Avatar(e.color, e.personality, this.nameOf(e))
      this.world.scene.add(av.root)
      this.avatars.push(av)
      const tr = new TrailView(e.color, this.half)
      this.world.scene.add(tr.mesh)
      this.trails.push(tr)
      const w = warnSprite()
      w.visible = false
      av.root.add(w)
      this.warn.push(w)
    }
    this.prev = this.arena.entities.map(e => ({ x: e.x, z: e.z }))
    this.lastPaths = this.arena.entities.map(() => [])
    this.fx.clear()
  }

  relabel(): void {
    this.arena.entities.forEach((e, i) => this.avatars[i].setName(this.nameOf(e), e.isPlayer))
  }

  /** Start a new match immediately. */
  start(seed: number): void {
    this.arena = new Arena(seed, true)
    this.buildEntities()
    this.mode = 'playing'
    this.hitstop = 0
    this.slowmo = 0
    this.pendingResult = null
    this.beatFrenzy = false
    this.beatFinal = false
    this.lastTick = 0
    this.recordShown = false
    this.targetShown = false
    this.firstCaptureDone = false
    this.nearestHome = -1
    this.snapshot = null
    const p = this.arena.player
    this.cam.snap(p.x - this.half, p.z - this.half)
    this.avatars.forEach(a => a.spawn())
    this.buildGuide()
    this.audio.play('start')
    this.hooks.banner('go', 'go')
  }

  toAttract(): void {
    this.arena = new Arena((Math.random() * 2 ** 31) >>> 0, false)
    this.buildEntities()
    this.mode = 'attract'
    this.guide.visible = false
    this.guideOn = false
    this.homeArrow.visible = false
  }

  pause(): void {
    if (this.mode === 'playing') this.mode = 'paused'
  }
  resume(): void {
    if (this.mode === 'paused') this.mode = 'playing'
  }

  setQuality(q: Quality): void {
    this.renderer.applyQuality(q)
    this.fx.lowQuality = q === 'low'
    this.world.sun.castShadow = q !== 'low'
    this.board.mesh.castShadow = q === 'high'
  }

  /** Suggested loop for first-timers: a dotted square from the edge of the start territory. */
  private buildGuide(): void {
    this.guideOn = this.tutorial
    this.guide.visible = this.guideOn
    if (!this.guideOn) return
    const p = this.arena.player
    const n = CONFIG.grid.size
    const toC = Math.atan2(n / 2 - p.z, n / 2 - p.x)
    const dx = Math.cos(toC)
    const dz = Math.sin(toC)
    const px = -dz
    const pz = dx
    const r = CONFIG.start.radius
    const out = 5
    const w = 5
    const pts: Array<[number, number]> = []
    const corners: Array<[number, number]> = [
      [p.x + dx * (r - 0.5) + px * 1.5, p.z + dz * (r - 0.5) + pz * 1.5],
      [p.x + dx * (r + out) + px * 1.5, p.z + dz * (r + out) + pz * 1.5],
      [p.x + dx * (r + out) - px * (w - 1.5), p.z + dz * (r + out) - pz * (w - 1.5)],
      [p.x + dx * (r - 0.5) - px * (w - 1.5), p.z + dz * (r - 0.5) - pz * (w - 1.5)],
    ]
    for (let i = 0; i < 3; i += 1) {
      const [ax, az] = corners[i]
      const [bx, bz] = corners[i + 1]
      for (let k = 0; k < 13; k += 1) pts.push([ax + ((bx - ax) * k) / 13, az + ((bz - az) * k) / 13])
    }
    const m = new THREE.Matrix4()
    for (let i = 0; i < this.guide.count; i += 1) {
      const q = pts[Math.min(i, pts.length - 1)]
      m.makeTranslation(q[0] - this.half, 0.55, q[1] - this.half)
      this.guide.setMatrixAt(i, m)
    }
    this.guide.count = Math.min(40, pts.length)
    this.guide.instanceMatrix.needsUpdate = true
    // Point the player along the guide.
    p.heading = toC
  }

  /** Fixed-step simulation. */
  step(dt: number): void {
    this.fx.step(dt)
    if (this.mode === 'paused') return
    if (this.hitstop > 0) {
      this.hitstop -= dt
      return
    }
    const simDt = dt * (this.slowmo > 0 ? 0.35 : 1)
    this.slowmo = Math.max(0, this.slowmo - dt)
    const a = this.arena
    if (this.mode === 'playing') this.steerPlayer()
    else a.playerInput = { x: 0, z: 0, boost: false }
    const running = this.mode === 'attract' || this.mode === 'playing' || this.mode === 'dying' || (this.mode === 'ended' && !a.player.alive)
    if (!running) return
    if (this.mode === 'playing' && a.player.alive) {
      if (!this.snapshot || this.snapshot.length !== a.grid.owner.length) this.snapshot = new Int8Array(a.grid.owner.length)
      this.snapshot.set(a.grid.owner)
    }
    a.entities.forEach((e, i) => {
      this.prev[i].x = e.x
      this.prev[i].z = e.z
      this.lastPaths[i] = e.path
    })
    const events = a.step(this.mode === 'dying' ? dt * 0.3 : simDt)
    for (const ev of events) this.handle(ev)
    if (this.mode === 'playing') {
      if (!a.player.alive) this.onPlayerDeath(a.player.deathReason ?? 'cut')
      else if (a.time >= CONFIG.round.seconds) this.finish('time')
      else this.beats()
    }
    if (this.mode === 'dying') {
      this.dyingTimer -= dt
      if (this.dyingTimer <= 0 && this.pendingResult) {
        this.mode = 'ended'
        this.hooks.end(this.pendingResult)
      }
    }
  }

  private steerPlayer(): void {
    const a = this.arena
    const p = a.player
    let x = this.input.move.x
    let z = -this.input.move.y
    if (this.input.pointer.active && x === 0 && z === 0) {
      const rect = this.renderer.canvas.getBoundingClientRect()
      this.ndc.set(((this.input.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.input.pointer.y - rect.top) / rect.height) * 2 + 1)
      this.raycaster.setFromCamera(this.ndc, this.cam.camera)
      if (this.raycaster.ray.intersectPlane(this.plane, this.hit)) {
        const tx = this.hit.x + this.half - p.x
        const tz = this.hit.z + this.half - p.z
        if (Math.hypot(tx, tz) > 0.9) {
          x = tx
          z = tz
        }
      }
    }
    const boost = this.input.consume('boost')
    a.playerInput = { x, z, boost }
  }

  private beats(): void {
    const left = this.arena.timeLeft
    if (!this.beatFrenzy && left <= CONFIG.beats.frenzy) {
      this.beatFrenzy = true
      this.hooks.banner('frenzy', 'frenzy')
      this.audio.play('frenzy')
    }
    if (!this.beatFinal && left <= CONFIG.beats.final) {
      this.beatFinal = true
      this.hooks.banner('final', 'final')
    }
    if (left <= CONFIG.beats.final) {
      const s = Math.ceil(left)
      if (s !== this.lastTick) {
        this.lastTick = s
        this.audio.play('tick')
      }
    }
    // Live score milestones.
    const score = this.liveScore()
    if (!this.recordShown && this.bestScore > 0 && score > this.bestScore) {
      this.recordShown = true
      this.hooks.banner('record', 'record')
      this.audio.play('record')
    }
    if (!this.targetShown && this.targetScore > 0 && score > this.targetScore) {
      this.targetShown = true
      this.hooks.banner('target', 'target')
      this.audio.play('target')
    }
  }

  /** Final map for the share card: live grid if the player survived, else the pre-death snapshot. */
  finalOwner(): Int8Array {
    const owner = this.arena.player.alive || !this.snapshot ? this.arena.grid.owner : this.snapshot
    return new Int8Array(owner)
  }

  liveScore(): number {
    const p = this.arena.player
    return composeScore({ territoryBp: this.arena.bpOf(0), kills: p.kills, comboBonus: p.comboBonus, survived: false })
  }

  private onPlayerDeath(reason: EndReason): void {
    this.pendingResult = this.arena.result(reason)
    this.mode = 'dying'
    this.dyingTimer = 1.3
    this.audio.play('death')
    this.hooks.flash('death')
    this.cam.shake(1.3)
    this.homeArrow.visible = false
    this.guide.visible = false
  }

  private finish(reason: EndReason): void {
    const result = this.arena.result(reason)
    this.mode = 'ended'
    this.homeArrow.visible = false
    this.guide.visible = false
    this.audio.play('end')
    const p = this.arena.player
    const cols = this.arena.entities.map(e => e.color)
    this.fx.confetti(p.x - this.half, p.z - this.half, [...cols, '#ffffff'], 90)
    window.setTimeout(() => this.hooks.end(result), 1100)
  }

  private screenOf(gx: number, gz: number, y = 1.4): { x: number; y: number } {
    this.v.set(gx - this.half, y, gz - this.half).project(this.cam.camera)
    const rect = this.renderer.canvas.getBoundingClientRect()
    return { x: rect.left + ((this.v.x + 1) / 2) * rect.width, y: rect.top + ((1 - this.v.y) / 2) * rect.height }
  }

  private handle(ev: ArenaEvent): void {
    const a = this.arena
    const playing = this.mode === 'playing' || this.mode === 'dying'
    switch (ev.type) {
      case 'capture': {
        const e = a.entities[ev.id]
        this.board.apply(ev.changes, a.grid.owner, this.now, { x: ev.x, z: ev.z }, 1, ev.gained > 200 ? 0.012 : 0.02)
        const wx = ev.x - this.half
        const wz = ev.z - this.half
        const big = ev.gained
        this.fx.ring(wx, wz, e.color, 2 + Math.sqrt(big) * 0.55, 0.7)
        // Sparkles over a sample of the captured cells.
        const sample = Math.min(e.isPlayer ? 46 : 14, Math.ceil(big / 5))
        for (let i = 0; i < sample; i += 1) {
          const c = ev.changes[Math.floor(Math.random() * ev.changes.length)].cell
          const n = CONFIG.grid.size
          this.fx.burst((c % n) + 0.5 - this.half, 0.7, Math.floor(c / n) + 0.5 - this.half, e.color, 2, 1.5, 5, 0.8, 1)
        }
        if (e.isPlayer && playing) {
          this.audio.capture(big, Math.max(1, ev.combo))
          this.cam.shake(Math.min(0.9, 0.25 + big / 300))
          const pct = formatPct(Math.floor((big * 10000) / a.grid.total))
          this.hooks.popup(`+${pct}`, this.screenOf(ev.x, ev.z, 1.6), big >= 150 ? 'big' : 'capture')
          if (ev.combo >= 2) this.hooks.popup(this.opts.t('combo', { n: ev.combo, bonus: ev.bonus }), this.screenOf(ev.x, ev.z, 3), 'combo')
          if (ev.closeCall) {
            this.hooks.popup(this.opts.t('closeCall'), this.screenOf(ev.x, ev.z, 4.2), 'danger')
            this.slowmo = 0.35
          }
          if (big >= 150) {
            this.hooks.banner('bigGrab', 'big')
            this.fx.confetti(wx, wz, [e.color, '#ffffff', '#fff27a'], 50)
          }
          this.hooks.flash('capture')
          if (!this.firstCaptureDone) {
            this.firstCaptureDone = true
            this.guide.visible = false
            this.guideOn = false
            this.hooks.firstCapture()
          }
        }
        break
      }
      case 'kill': {
        const v = a.entities[ev.victim]
        const k = ev.killer >= 0 ? a.entities[ev.killer] : null
        const wx = ev.x - this.half
        const wz = ev.z - this.half
        this.board.apply(ev.changes, a.grid.owner, this.now, { x: ev.x, z: ev.z }, 2, 0.012)
        this.fx.shatter(wx, wz, v.color, v.isPlayer ? 22 : 14)
        this.fx.burst(wx, 0.9, wz, v.color, 30, 9, 7, 0.9, 1.3)
        this.fx.burst(wx, 0.9, wz, '#ffffff', 12, 6, 5, 0.6, 1)
        this.fx.ring(wx, wz, '#ffffff', 7, 0.55, 0.7)
        this.fx.ring(wx, wz, v.color, 11, 0.8, 0.66)
        // The broken line bursts along its length.
        for (const pt of TrailView.sample(this.lastPaths[ev.victim] ?? [], 3).slice(0, 60)) {
          this.fx.burst(pt.x - this.half, 0.7, pt.z - this.half, v.color, 2, 2.5, 4, 0.6, 0.9)
        }
        const near = Math.hypot(a.player.x - ev.x, a.player.z - ev.z) < 18
        if (k?.isPlayer && playing) {
          this.audio.play('kill')
          this.hitstop = 0.09
          this.cam.shake(0.9)
          this.hooks.flash('kill')
          this.hooks.popup(this.opts.t('knockout', { name: this.nameOf(v), bonus: CONFIG.score.killBonus }), this.screenOf(ev.x, ev.z, 2.4), 'kill')
        } else if (!v.isPlayer && near && this.mode !== 'attract') {
          this.cam.shake(0.3)
        }
        if (this.mode !== 'attract') this.hooks.feed(k ? { name: this.nameOf(k), color: k.color } : null, { name: this.nameOf(v), color: v.color }, ev.reason)
        break
      }
      case 'respawn': {
        const e = a.entities[ev.id]
        this.board.apply(ev.changes, a.grid.owner, this.now, { x: e.x, z: e.z }, 3, 0.03)
        this.avatars[ev.id].spawn()
        this.prev[ev.id] = { x: e.x, z: e.z }
        this.fx.ring(e.x - this.half, e.z - this.half, e.color, 4, 0.5)
        break
      }
      case 'leave':
        if (a.entities[ev.id].isPlayer && playing) this.audio.play('leave')
        break
      case 'boost': {
        const e = a.entities[ev.id]
        this.avatars[ev.id].boost()
        if (e.isPlayer && playing) {
          this.audio.play('boost')
          this.fx.burst(e.x - this.half, 0.6, e.z - this.half, '#ffffff', 10, 4, 2, 0.4, 0.8)
        }
        break
      }
      case 'nearMiss':
        if (playing) {
          this.audio.play('nearMiss')
          this.hooks.popup(this.opts.t('nearMiss'), this.screenOf(ev.x, ev.z, 3.4), 'danger')
          this.slowmo = 0.25
        }
        break
    }
  }

  hud(): HudState {
    const a = this.arena
    const p = a.player
    return {
      timeLeft: a.timeLeft,
      bp: a.bpOf(0),
      score: this.liveScore(),
      combo: p.combo,
      comboFrac: p.comboTimer / CONFIG.score.comboWindow,
      kills: p.kills,
      place: a.placeOf(0),
      outside: p.outside,
      danger: this.mode === 'playing' ? a.danger : 0,
      boostReady: p.boostCd <= 0 ? 1 : 1 - p.boostCd / (CONFIG.player.boostCooldown + CONFIG.player.boostTime),
      rivals: a.entities
        .filter(e => !e.isPlayer)
        .map(e => ({ id: e.id, name: this.nameOf(e), color: e.color, personality: e.personality, bp: a.bpOf(e.id), alive: e.alive, respawnIn: e.respawnIn, hunting: a.isHuntingPlayer(e.id) }))
        .sort((x, y) => y.bp - x.bp),
    }
  }

  render(alpha: number, frameSeconds: number): void {
    const dt = Math.min(0.05, frameSeconds)
    this.now += dt
    const a = this.arena
    const time = this.now
    const n = CONFIG.grid.size
    a.entities.forEach((e, i) => {
      const k = this.mode === 'paused' || this.hitstop > 0 ? 1 : alpha
      const x = this.prev[i].x + (e.x - this.prev[i].x) * k
      const z = this.prev[i].z + (e.z - this.prev[i].z) * k
      const ground = this.board.heightAt(a.grid.cellAt(x, z))
      this.avatars[i].update(x - this.half, Math.max(0.16, ground), z - this.half, e.heading, dt, time, e.alive, e.boostLeft > 0)
      const danger = e.isPlayer ? a.danger : 0
      this.trails[i].update(e.alive ? e.path : [], x, z, danger, time)
      this.warn[i].visible = e.alive && a.isHuntingPlayer(e.id) && this.mode === 'playing'
      if (this.warn[i].visible) this.warn[i].position.y = 2.9 + Math.sin(time * 10) * 0.1
    })
    const p = a.player
    if (this.mode === 'attract') this.cam.attract(n, dt)
    else {
      const trailLen = p.trail.length
      const zoom = 1 + Math.min(0.35, trailLen / 120) + (p.boostLeft > 0 ? 0.06 : 0) + (this.mode === 'dying' ? -0.15 : 0) + (this.mode === 'ended' ? 0.25 : 0)
      this.cam.follow(p.x - this.half, p.z - this.half, p.heading, zoom, dt)
    }
    // Arrow home while outside.
    if (this.mode === 'playing' && p.alive && p.outside) {
      this.homeScan -= 1
      if (this.homeScan <= 0 || this.nearestHome < 0) {
        this.homeScan = 6
        this.nearestHome = a.grid.nearestOwned(0, p.x, p.z)
      }
      if (this.nearestHome >= 0) {
        const hx = (this.nearestHome % n) + 0.5 - p.x
        const hz = Math.floor(this.nearestHome / n) + 0.5 - p.z
        const ang = Math.atan2(hz, hx)
        const r = 1.7 + Math.sin(time * 8) * 0.12
        this.homeArrow.position.set(p.x - this.half + Math.cos(ang) * r, 0.9, p.z - this.half + Math.sin(ang) * r)
        this.homeArrow.rotation.set(0, -ang, 0)
        ;(this.homeArrow.material as THREE.MeshBasicMaterial).color.set(a.danger > 0.5 ? '#ff3b4d' : '#ffffff')
        this.homeArrow.visible = true
      }
    } else this.homeArrow.visible = false
    if (this.guideOn) (this.guide.material as THREE.MeshBasicMaterial).opacity = 0.55 + Math.sin(time * 6) * 0.3
    // Heartbeat when a rival is about to cut the line.
    if (this.mode === 'playing' && a.danger > 0.55) {
      this.heartbeat -= dt
      if (this.heartbeat <= 0) {
        this.heartbeat = 0.62 - a.danger * 0.25
        this.audio.play('heartbeat')
      }
    } else this.heartbeat = 0
    this.audio.setIntensity(this.mode === 'playing' ? Math.max(a.ramp * 0.8, a.timeLeft < 30 ? 0.8 : 0) + (a.timeLeft < 10 ? 0.2 : 0) : 0.15)
    this.cam.reducedMotion = this.reducedMotion
    this.board.update(this.now)
    this.fx.update(dt, alpha)
    this.world.update(dt)
    this.renderer.render(this.world.scene, this.cam.camera)
  }
}

function warnSprite(): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#ff3b4d'
  g.strokeStyle = '#1d1640'
  g.lineWidth = 6
  g.beginPath()
  g.moveTo(32, 4)
  g.lineTo(60, 58)
  g.lineTo(4, 58)
  g.closePath()
  g.fill()
  g.stroke()
  g.fillStyle = '#ffffff'
  g.font = '900 36px system-ui, sans-serif'
  g.textAlign = 'center'
  g.fillText('!', 32, 52)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }))
  s.scale.set(0.9, 0.9, 1)
  s.position.y = 2.9
  s.renderOrder = 11
  return s
}
