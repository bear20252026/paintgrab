import * as THREE from 'three'
import { Physics, RAPIER } from '../engine/physics'

type Particle = { alive: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; spin: number; color: THREE.Color; gravity: number }
type Ring = { mesh: THREE.Mesh; t: number; dur: number; scale: number; alive: boolean }
type Debris = { mesh: THREE.Mesh; body: RAPIER.RigidBody; life: number }

const MAX_PARTICLES = 900

/**
 * Pooled effects: instanced particles (bursts, confetti, sparks), expanding shock rings, and
 * Rapier-simulated shards for eliminations that bounce on the arena floor.
 */
export class Fx {
  readonly group = new THREE.Group()
  private readonly particles: Particle[] = []
  private readonly mesh: THREE.InstancedMesh
  private readonly rings: Ring[] = []
  private readonly debris: Debris[] = []
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()
  private readonly v = new THREE.Vector3()
  private readonly s = new THREE.Vector3()
  private readonly shardGeo = new THREE.TetrahedronGeometry(0.28, 0)
  private readonly physics: Physics
  private cursor = 0
  lowQuality = false

  constructor(size: number) {
    this.mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.16, 0), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_PARTICLES)
    this.mesh.frustumCulled = false
    this.mesh.count = MAX_PARTICLES
    this.m.makeScale(0, 0, 0)
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      this.particles.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1, spin: 0, color: new THREE.Color(), gravity: -14 })
      this.mesh.setMatrixAt(i, this.m)
      this.mesh.setColorAt(i, new THREE.Color('#ffffff'))
    }
    this.group.add(this.mesh)
    for (let i = 0; i < 10; i += 1) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 40), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }))
      ring.rotation.x = -Math.PI / 2
      ring.visible = false
      this.group.add(ring)
      this.rings.push({ mesh: ring, t: 0, dur: 1, scale: 1, alive: false })
    }
    this.physics = new Physics(-26)
    // Floor for shards: the top of the owned plateau, slightly generous beyond the rail.
    this.physics.addStaticBox(new THREE.Vector3(0, -0.5 + 0.34, 0), new THREE.Vector3(size + 6, 1, size + 6), undefined, 0.6)
  }

  burst(x: number, y: number, z: number, color: THREE.ColorRepresentation, count: number, speed = 6, up = 6, life = 0.9, size = 1): void {
    const n = this.lowQuality ? Math.ceil(count / 2) : count
    const c = new THREE.Color(color)
    for (let i = 0; i < n; i += 1) {
      const p = this.particles[this.cursor]
      this.cursor = (this.cursor + 1) % MAX_PARTICLES
      const a = Math.random() * Math.PI * 2
      const sp = speed * (0.35 + Math.random() * 0.65)
      p.alive = true
      p.x = x
      p.y = y
      p.z = z
      p.vx = Math.cos(a) * sp
      p.vz = Math.sin(a) * sp
      p.vy = up * (0.4 + Math.random() * 0.8)
      p.life = 0
      p.max = life * (0.6 + Math.random() * 0.6)
      p.size = size * (0.6 + Math.random() * 0.9)
      p.spin = (Math.random() - 0.5) * 16
      p.gravity = -16
      p.color.copy(c).offsetHSL(0, 0, (Math.random() - 0.5) * 0.25)
    }
  }

  /** Multi-colour confetti rain above a point. */
  confetti(x: number, z: number, colors: string[], count = 60): void {
    for (let i = 0; i < count; i += 1) this.burst(x + (Math.random() - 0.5) * 6, 3 + Math.random() * 3, z + (Math.random() - 0.5) * 6, colors[i % colors.length], 1, 3, 5, 1.6, 1.1)
  }

  ring(x: number, z: number, color: THREE.ColorRepresentation, scale: number, dur = 0.6, y = 0.62): void {
    const r = this.rings.find(k => !k.alive) ?? this.rings[0]
    r.alive = true
    r.t = 0
    r.dur = dur
    r.scale = scale
    r.mesh.position.set(x, y, z)
    ;(r.mesh.material as THREE.MeshBasicMaterial).color.set(color)
    r.mesh.visible = true
  }

  shatter(x: number, z: number, color: THREE.ColorRepresentation, count = 14): void {
    const n = this.lowQuality ? Math.ceil(count / 2) : count
    const mat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.5, emissive: color, emissiveIntensity: 0.25 })
    for (let i = 0; i < n; i += 1) {
      if (this.debris.length > 70) this.removeDebris(0)
      const mesh = new THREE.Mesh(this.shardGeo, mat)
      mesh.castShadow = true
      mesh.position.set(x + (Math.random() - 0.5) * 0.6, 0.9 + Math.random() * 0.6, z + (Math.random() - 0.5) * 0.6)
      mesh.scale.setScalar(0.7 + Math.random() * 0.9)
      this.group.add(mesh)
      const body = this.physics.addDynamic(mesh, RAPIER.ColliderDesc.ball(0.18 * mesh.scale.x).setRestitution(0.45).setFriction(0.8), 0.4)
      const a = Math.random() * Math.PI * 2
      const sp = 3 + Math.random() * 5
      body.setLinvel({ x: Math.cos(a) * sp, y: 5 + Math.random() * 6, z: Math.sin(a) * sp }, true)
      body.setAngvel({ x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20, z: (Math.random() - 0.5) * 20 }, true)
      this.debris.push({ mesh, body, life: 2.4 + Math.random() * 0.8 })
    }
  }

  private removeDebris(i: number): void {
    const d = this.debris[i]
    this.physics.removeBody(d.body)
    this.group.remove(d.mesh)
    this.debris.splice(i, 1)
  }

  /** Fixed-step part (physics). */
  step(dt: number): void {
    if (this.debris.length > 0) this.physics.step(dt)
    for (let i = this.debris.length - 1; i >= 0; i -= 1) {
      const d = this.debris[i]
      d.life -= dt
      if (d.life <= 0) this.removeDebris(i)
    }
  }

  update(dt: number, alpha: number): void {
    if (this.debris.length > 0) this.physics.sync(alpha)
    for (const d of this.debris) if (d.life < 0.5) d.mesh.scale.multiplyScalar(0.9)
    let dirty = false
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      const p = this.particles[i]
      if (!p.alive) continue
      dirty = true
      p.life += dt
      if (p.life >= p.max) {
        p.alive = false
        this.m.makeScale(0, 0, 0)
        this.mesh.setMatrixAt(i, this.m)
        continue
      }
      p.vy += p.gravity * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      if (p.y < 0.55) {
        p.y = 0.55
        p.vy *= -0.4
        p.vx *= 0.7
        p.vz *= 0.7
      }
      const k = 1 - p.life / p.max
      const sz = p.size * (0.3 + 0.7 * k)
      this.e.set(p.life * p.spin, p.life * p.spin * 0.7, 0)
      this.m.compose(this.v.set(p.x, p.y, p.z), this.q.setFromEuler(this.e), this.s.set(sz, sz, sz))
      this.mesh.setMatrixAt(i, this.m)
      this.mesh.setColorAt(i, p.color)
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    }
    for (const r of this.rings) {
      if (!r.alive) continue
      r.t += dt
      const k = r.t / r.dur
      if (k >= 1) {
        r.alive = false
        r.mesh.visible = false
        continue
      }
      const e = 1 - Math.pow(1 - k, 3)
      const s = 0.3 + e * r.scale
      r.mesh.scale.set(s, s, s)
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9
    }
  }

  clear(): void {
    while (this.debris.length) this.removeDebris(0)
    for (const p of this.particles) p.alive = false
    this.m.makeScale(0, 0, 0)
    for (let i = 0; i < MAX_PARTICLES; i += 1) this.mesh.setMatrixAt(i, this.m)
    this.mesh.instanceMatrix.needsUpdate = true
    for (const r of this.rings) {
      r.alive = false
      r.mesh.visible = false
    }
  }
}
