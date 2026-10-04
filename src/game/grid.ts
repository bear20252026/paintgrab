/**
 * Territory grid (pure data, no rendering). Each cell has an owner (-1 = neutral) and an optional
 * trail owner. Capturing turns an entity's trail into territory and fills every region its
 * territory now encloses: whatever cannot reach the map edge through non-owned cells.
 */
export type CellChange = { cell: number; prev: number }

export class Grid {
  readonly owner: Int8Array
  readonly trail: Int8Array
  readonly counts: number[]
  readonly total: number
  private readonly seen: Uint8Array
  private readonly stack: Int32Array

  constructor(readonly size: number, maxEntities = 8) {
    this.total = size * size
    this.owner = new Int8Array(this.total).fill(-1)
    this.trail = new Int8Array(this.total).fill(-1)
    this.counts = new Array(maxEntities).fill(0)
    this.seen = new Uint8Array(this.total)
    this.stack = new Int32Array(this.total)
  }

  index(x: number, z: number): number {
    return z * this.size + x
  }
  inside(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.size && z < this.size
  }
  cellAt(px: number, pz: number): number {
    const x = Math.min(this.size - 1, Math.max(0, Math.floor(px)))
    const z = Math.min(this.size - 1, Math.max(0, Math.floor(pz)))
    return this.index(x, z)
  }

  private set(cell: number, id: number, out: CellChange[]): void {
    const prev = this.owner[cell]
    if (prev === id) return
    if (prev >= 0) this.counts[prev] -= 1
    if (id >= 0) this.counts[id] += 1
    this.owner[cell] = id
    out.push({ cell, prev })
  }

  /** Give `id` every cell within `radius` of (cx, cz). */
  claimDisk(id: number, cx: number, cz: number, radius: number): CellChange[] {
    const out: CellChange[] = []
    const r = Math.ceil(radius)
    for (let z = Math.floor(cz) - r; z <= Math.floor(cz) + r; z += 1) {
      for (let x = Math.floor(cx) - r; x <= Math.floor(cx) + r; x += 1) {
        if (!this.inside(x, z)) continue
        if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) <= radius) this.set(this.index(x, z), id, out)
      }
    }
    return out
  }

  /** True when every cell of the disk is neutral and trail-free. */
  diskFree(cx: number, cz: number, radius: number): boolean {
    const r = Math.ceil(radius) + 1
    for (let z = Math.floor(cz) - r; z <= Math.floor(cz) + r; z += 1) {
      for (let x = Math.floor(cx) - r; x <= Math.floor(cx) + r; x += 1) {
        if (!this.inside(x, z)) return false
        const c = this.index(x, z)
        if (this.owner[c] !== -1 || this.trail[c] !== -1) return false
      }
    }
    return true
  }

  /** Convert `trailCells` into territory for `id` and fill enclosed regions. */
  capture(id: number, trailCells: readonly number[]): CellChange[] {
    const out: CellChange[] = []
    for (const c of trailCells) {
      if (this.trail[c] === id) this.trail[c] = -1
      this.set(c, id, out)
    }
    const n = this.size
    const seen = this.seen
    const stack = this.stack
    seen.fill(0)
    let top = 0
    const seed = (c: number) => {
      if (!seen[c] && this.owner[c] !== id) {
        seen[c] = 1
        stack[top++] = c
      }
    }
    for (let i = 0; i < n; i += 1) {
      seed(i)
      seed((n - 1) * n + i)
      seed(i * n)
      seed(i * n + n - 1)
    }
    while (top > 0) {
      const c = stack[--top]
      const x = c % n
      if (x > 0) seed(c - 1)
      if (x < n - 1) seed(c + 1)
      if (c >= n) seed(c - n)
      if (c < n * (n - 1)) seed(c + n)
    }
    for (let c = 0; c < this.total; c += 1) {
      if (!seen[c] && this.owner[c] !== id) this.set(c, id, out)
    }
    return out
  }

  /** Neutralise all of `id`'s territory (elimination). */
  clearOwner(id: number): CellChange[] {
    const out: CellChange[] = []
    for (let c = 0; c < this.total; c += 1) if (this.owner[c] === id) this.set(c, -1, out)
    return out
  }

  clearTrail(id: number, cells: readonly number[]): void {
    for (const c of cells) if (this.trail[c] === id) this.trail[c] = -1
  }

  /** Nearest cell owned by `id` to a point (cell index, or -1). */
  nearestOwned(id: number, px: number, pz: number): number {
    let best = -1
    let bestD = Infinity
    const n = this.size
    for (let c = 0; c < this.total; c += 1) {
      if (this.owner[c] !== id) continue
      const dx = (c % n) + 0.5 - px
      const dz = Math.floor(c / n) + 0.5 - pz
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    return best
  }
}
