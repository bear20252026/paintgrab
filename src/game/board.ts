import * as THREE from 'three'
import type { CellChange } from './grid'

const NEUTRAL_H = 0.16
const OWNED_H = 0.5
const NEUTRAL_SCALE = 0.93

const easeOutBack = (t: number) => {
  const c1 = 2.2
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}
const hash = (i: number) => {
  let h = Math.imul(i ^ 0x5bd1e995, 0x27d4eb2d)
  h ^= h >>> 15
  return ((h >>> 0) % 1000) / 1000
}

/**
 * The arena floor: one instanced low-poly block per grid cell. Owned cells rise into a plateau in
 * the owner's colour; capture changes are scheduled as a wave spreading from where the loop closed,
 * each block popping up with a white flash.
 */
export class BoardView {
  readonly mesh: THREE.InstancedMesh
  private readonly n: number
  private readonly h: Float32Array
  private readonly sc: Float32Array
  private readonly col: Float32Array
  private readonly from: Float32Array
  private readonly to: Float32Array
  private readonly start: Float64Array
  private readonly kind: Uint8Array
  private readonly active = new Set<number>()
  private readonly palette: THREE.Color[]
  private readonly m = new THREE.Matrix4()
  private readonly c = new THREE.Color()
  private readonly half: number

  constructor(readonly size: number, colors: string[]) {
    this.n = size * size
    this.half = size / 2
    const geo = new THREE.BoxGeometry(1, 1, 1)
    geo.translate(0, 0.5, 0)
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0, flatShading: true })
    this.mesh = new THREE.InstancedMesh(geo, mat, this.n)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.h = new Float32Array(this.n).fill(NEUTRAL_H)
    this.sc = new Float32Array(this.n).fill(NEUTRAL_SCALE)
    this.col = new Float32Array(this.n * 3)
    this.from = new Float32Array(this.n * 5)
    this.to = new Float32Array(this.n * 5)
    this.start = new Float64Array(this.n)
    this.kind = new Uint8Array(this.n)
    this.palette = colors.map(c => new THREE.Color(c))
    for (let i = 0; i < this.n; i += 1) {
      this.neutral(i, this.c)
      this.col.set([this.c.r, this.c.g, this.c.b], i * 3)
      this.write(i)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  setPalette(colors: string[]): void {
    colors.forEach((c, i) => this.palette[i]?.set(c))
  }

  private neutral(i: number, out: THREE.Color): THREE.Color {
    const x = i % this.size
    const z = Math.floor(i / this.size)
    const base = (x + z) % 2 === 0 ? 0.93 : 0.87
    const j = (hash(i) - 0.5) * 0.03
    return out.setRGB(base + j - 0.02, base + j - 0.04, base + j + 0.03, THREE.SRGBColorSpace)
  }

  private ownerColor(owner: number, i: number, out: THREE.Color): THREE.Color {
    out.copy(this.palette[owner] ?? this.palette[0])
    const j = (hash(i * 7 + 3) - 0.5) * 0.09
    const x = i % this.size
    const z = Math.floor(i / this.size)
    const checker = (x + z) % 2 === 0 ? 0.035 : -0.035
    out.offsetHSL(0, 0, j + checker)
    return out
  }

  private write(i: number): void {
    const x = i % this.size
    const z = Math.floor(i / this.size)
    const s = this.sc[i]
    this.m.makeScale(s, this.h[i], s)
    this.m.setPosition(x + 0.5 - this.half, 0, z + 0.5 - this.half)
    this.mesh.setMatrixAt(i, this.m)
    this.c.setRGB(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2])
    this.mesh.setColorAt(i, this.c)
  }

  /** Snap every cell to the given owner map (new match). */
  reset(owner: Int8Array): void {
    this.active.clear()
    for (let i = 0; i < this.n; i += 1) {
      const o = owner[i]
      if (o >= 0) this.ownerColor(o, i, this.c)
      else this.neutral(i, this.c)
      this.col.set([this.c.r, this.c.g, this.c.b], i * 3)
      this.h[i] = o >= 0 ? OWNED_H + hash(i) * 0.04 : NEUTRAL_H
      this.sc[i] = o >= 0 ? 1 : NEUTRAL_SCALE
      this.write(i)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /**
   * Animate cells to their new owner. `origin` is in grid space; delay grows with distance so the
   * colour visibly spreads. Kind 1 = capture pop, 2 = collapse to neutral, 3 = quick spawn.
   */
  apply(changes: CellChange[], owner: Int8Array, now: number, origin: { x: number; z: number }, kind: 1 | 2 | 3, spread = 0.018): number {
    let maxDelay = 0
    for (const { cell } of changes) {
      const o = owner[cell]
      const x = (cell % this.size) + 0.5
      const z = Math.floor(cell / this.size) + 0.5
      const delay = Math.min(0.85, Math.hypot(x - origin.x, z - origin.z) * spread + hash(cell) * 0.04)
      maxDelay = Math.max(maxDelay, delay)
      const f = cell * 5
      this.from[f] = this.h[cell]
      this.from[f + 1] = this.sc[cell]
      this.from[f + 2] = this.col[cell * 3]
      this.from[f + 3] = this.col[cell * 3 + 1]
      this.from[f + 4] = this.col[cell * 3 + 2]
      if (o >= 0) this.ownerColor(o, cell, this.c)
      else this.neutral(cell, this.c)
      this.to[f] = o >= 0 ? OWNED_H + hash(cell) * 0.04 : NEUTRAL_H
      this.to[f + 1] = o >= 0 ? 1 : NEUTRAL_SCALE
      this.to[f + 2] = this.c.r
      this.to[f + 3] = this.c.g
      this.to[f + 4] = this.c.b
      this.start[cell] = now + delay
      this.kind[cell] = kind
      this.active.add(cell)
    }
    return maxDelay
  }

  update(now: number): void {
    if (this.active.size === 0) return
    for (const i of this.active) {
      const k = this.kind[i]
      const dur = k === 2 ? 0.5 : k === 3 ? 0.3 : 0.45
      const t = (now - this.start[i]) / dur
      if (t < 0) continue
      const f = i * 5
      if (t >= 1) {
        this.h[i] = this.to[f]
        this.sc[i] = this.to[f + 1]
        this.col[i * 3] = this.to[f + 2]
        this.col[i * 3 + 1] = this.to[f + 3]
        this.col[i * 3 + 2] = this.to[f + 4]
        this.write(i)
        this.active.delete(i)
        continue
      }
      let hk: number
      let flash = 0
      if (k === 2) {
        hk = t * t
        flash = 0
      } else {
        hk = easeOutBack(t)
        flash = Math.max(0, 1 - t * 2.2) * (k === 1 ? 0.75 : 0.4)
      }
      this.h[i] = this.from[f] + (this.to[f] - this.from[f]) * hk + (k === 1 ? Math.sin(t * Math.PI) * 0.25 : 0)
      this.sc[i] = this.from[f + 1] + (this.to[f + 1] - this.from[f + 1]) * Math.min(1, t * 1.6)
      const ct = Math.min(1, t * 2.4)
      for (let ch = 0; ch < 3; ch += 1) {
        const v = this.from[f + 2 + ch] + (this.to[f + 2 + ch] - this.from[f + 2 + ch]) * ct
        this.col[i * 3 + ch] = v + (1 - v) * flash
      }
      this.write(i)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /** Top height of a cell right now (for placing avatars/effects). */
  heightAt(cell: number): number {
    return this.h[cell] ?? NEUTRAL_H
  }
}

export const TILE = { NEUTRAL_H, OWNED_H }
