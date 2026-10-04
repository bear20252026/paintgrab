import * as THREE from 'three'

/**
 * Tilted top-down follow camera. Leads slightly in the travel direction, pulls back while the
 * player's line is long or boosting, shakes on impacts and orbits the arena on the title screen.
 */
export class FollowCamera {
  readonly camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 600)
  private readonly focus = new THREE.Vector3()
  private readonly target = new THREE.Vector3()
  private zoom = 1
  private shakeAmp = 0
  private shakeT = 0
  private orbit = 0
  reducedMotion = false

  constructor() {
    this.camera.position.set(0, 40, 30)
  }

  shake(amount: number): void {
    if (this.reducedMotion) amount *= 0.3
    this.shakeAmp = Math.max(this.shakeAmp, amount)
  }

  snap(x: number, z: number): void {
    this.focus.set(x, 0, z)
  }

  follow(x: number, z: number, heading: number, wantZoom: number, dt: number): void {
    this.target.set(x + Math.cos(heading) * 2.2, 0, z + Math.sin(heading) * 2.2)
    const k = 1 - Math.exp(-dt * 5)
    this.focus.lerp(this.target, k)
    this.zoom += (wantZoom - this.zoom) * (1 - Math.exp(-dt * 2.2))
    const aspect = this.camera.aspect
    // Narrow screens need more height to show the same width of arena.
    const fit = aspect < 1.3 ? 1.3 / aspect : 1
    const dist = 22 * this.zoom * Math.min(1.6, fit)
    this.place(this.focus.x, this.focus.z, dist, dt)
  }

  attract(size: number, dt: number): void {
    this.orbit += dt * 0.07
    const r = size * 0.12
    this.focus.set(Math.cos(this.orbit) * r, 0, Math.sin(this.orbit) * r)
    const fit = this.camera.aspect < 1.3 ? 1.3 / this.camera.aspect : 1
    this.place(this.focus.x, this.focus.z, size * 0.78 * Math.min(1.5, fit), dt, this.orbit * 0.6)
  }

  private place(fx: number, fz: number, dist: number, dt: number, yaw = 0): void {
    const pitch = 0.98
    const off = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist)
    this.camera.position.set(fx + off.x, off.y, fz + off.z)
    this.shakeT += dt
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * 2.6)
    const s = this.shakeAmp * this.shakeAmp
    const sx = Math.sin(this.shakeT * 61) * s
    const sy = Math.cos(this.shakeT * 53) * s
    this.camera.position.x += sx
    this.camera.position.y += sy
    this.camera.lookAt(fx + sx * 0.5, 0, fz)
  }
}
