import * as THREE from 'three'

const MAX_POINTS = 1400
const TOP = 0.66
const BOTTOM = 0.04
const HALF_W = 0.2

/**
 * A live trail as a glowing low wall: top strip plus two side faces, rebuilt from the entity's
 * path every frame (cheap: a few hundred points). Unlit vertex colours so it reads as neon.
 */
export class TrailView {
  readonly mesh: THREE.Mesh
  private readonly pos: Float32Array
  private readonly col: Float32Array
  private readonly geo: THREE.BufferGeometry
  private readonly base = new THREE.Color()
  private readonly hot = new THREE.Color('#ff2b3a')
  private readonly tmp = new THREE.Color()
  private readonly tmp2 = new THREE.Color()

  constructor(color: string, private readonly half: number) {
    this.base.set(color)
    this.geo = new THREE.BufferGeometry()
    this.pos = new Float32Array(MAX_POINTS * 4 * 3)
    this.col = new Float32Array(MAX_POINTS * 4 * 3)
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    const idx = new Uint32Array((MAX_POINTS - 1) * 18)
    for (let i = 0; i < MAX_POINTS - 1; i += 1) {
      const a = i * 4
      const b = (i + 1) * 4
      const o = i * 18
      // top: TL a, TR a+1, next TL b, TR b+1
      idx.set([a, b, a + 1, a + 1, b, b + 1], o)
      // left side: TL a, BL a+2
      idx.set([a, a + 2, b, b, a + 2, b + 2], o + 6)
      // right side: TR a+1, BR a+3
      idx.set([a + 1, b + 1, a + 3, a + 3, b + 1, b + 3], o + 12)
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1))
    this.geo.setDrawRange(0, 0)
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 1 }))
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
  }

  setColor(color: string): void {
    this.base.set(color)
  }

  /**
   * @param path flat [x, z…] in grid space
   * @param head current head position (grid space) appended as the live end
   * @param danger 0..1 pulses the trail toward red
   */
  update(path: number[], headX: number, headZ: number, danger: number, time: number, opacity = 1): void {
    const pts = Math.min(MAX_POINTS - 1, path.length / 2)
    if (pts < 1) {
      this.geo.setDrawRange(0, 0)
      return
    }
    const total = pts + 1
    const pulse = danger > 0 ? danger * (0.55 + 0.45 * Math.sin(time * (10 + danger * 14))) : 0
    this.tmp.copy(this.base).lerp(this.hot, Math.max(0, pulse))
    const topCol = this.tmp2.copy(this.tmp).offsetHSL(0, 0, 0.12)
    const topR = topCol.r
    const topG = topCol.g
    const topB = topCol.b
    const sideR = this.tmp.r * 0.75
    const sideG = this.tmp.g * 0.75
    const sideB = this.tmp.b * 0.75
    const px = (i: number) => (i < pts ? path[(path.length / 2 - pts + i) * 2] : headX)
    const pz = (i: number) => (i < pts ? path[(path.length / 2 - pts + i) * 2 + 1] : headZ)
    for (let i = 0; i < total; i += 1) {
      const x = px(i)
      const z = pz(i)
      const i0 = Math.max(0, i - 1)
      const i1 = Math.min(total - 1, i + 1)
      let dx = px(i1) - px(i0)
      let dz = pz(i1) - pz(i0)
      const len = Math.hypot(dx, dz) || 1
      dx /= len
      dz /= len
      const nx = -dz * HALF_W
      const nz = dx * HALF_W
      const wx = x - this.half
      const wz = z - this.half
      // Taper the first point so the trail grows out of the territory edge.
      const top = i === 0 ? TOP * 0.6 : TOP
      const o = i * 12
      this.pos[o] = wx + nx
      this.pos[o + 1] = top
      this.pos[o + 2] = wz + nz
      this.pos[o + 3] = wx - nx
      this.pos[o + 4] = top
      this.pos[o + 5] = wz - nz
      this.pos[o + 6] = wx + nx
      this.pos[o + 7] = BOTTOM
      this.pos[o + 8] = wz + nz
      this.pos[o + 9] = wx - nx
      this.pos[o + 10] = BOTTOM
      this.pos[o + 11] = wz - nz
      this.col.set([topR, topG, topB, topR, topG, topB, sideR * 0.7, sideG * 0.7, sideB * 0.7, sideR * 0.7, sideG * 0.7, sideB * 0.7], o)
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.color.needsUpdate = true
    this.geo.setDrawRange(0, (total - 1) * 18)
    ;(this.mesh.material as THREE.MeshBasicMaterial).opacity = opacity
  }

  /** Sampled points along the current trail (grid space) for shatter effects. */
  static sample(path: number[], every = 3): Array<{ x: number; z: number }> {
    const out: Array<{ x: number; z: number }> = []
    for (let i = 0; i < path.length; i += 2 * every) out.push({ x: path[i], z: path[i + 1] })
    return out
  }
}
