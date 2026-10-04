import * as THREE from 'three'
import { mulberry32 } from './rng'

/**
 * Static low-poly surroundings: sky dome, lights, the arena slab with a candy rail, a floating
 * island ring with trees and rocks, low-poly water and drifting clouds. Built once.
 */
export class World {
  readonly scene = new THREE.Scene()
  readonly sun: THREE.DirectionalLight
  private readonly water: THREE.Mesh
  private readonly waterBase: Float32Array
  private readonly clouds = new THREE.Group()
  private time = 0

  constructor(readonly size: number, shadowMapSize: number) {
    const scene = this.scene
    const half = size / 2
    scene.background = new THREE.Color('#9fd6ff')
    scene.fog = new THREE.Fog('#bfe3ff', 70, 170)

    // Sky dome with a vertical gradient.
    const skyGeo = new THREE.SphereGeometry(260, 24, 12)
    const skyCol: number[] = []
    const top = new THREE.Color('#5fb4ff')
    const mid = new THREE.Color('#bfe6ff')
    const low = new THREE.Color('#ffe3f1')
    const pos = skyGeo.attributes.position
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i) / 260
      const c = y > 0.1 ? mid.clone().lerp(top, Math.min(1, (y - 0.1) / 0.6)) : low.clone().lerp(mid, Math.max(0, (y + 0.3) / 0.4))
      skyCol.push(c.r, c.g, c.b)
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(skyCol, 3))
    scene.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })))

    scene.add(new THREE.HemisphereLight('#ffffff', '#b9a6ff', 1.35))
    this.sun = new THREE.DirectionalLight('#fff1dc', 2.3)
    this.sun.position.set(-26, 48, 20)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)
    const s = this.sun.shadow.camera
    s.left = -half - 6
    s.right = half + 6
    s.top = half + 6
    s.bottom = -half - 6
    s.near = 5
    s.far = 120
    this.sun.shadow.bias = -0.0008
    this.sun.shadow.normalBias = 0.04
    scene.add(this.sun, this.sun.target)

    const flat = (color: THREE.ColorRepresentation) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true })
    const rng = mulberry32(77)

    // Arena slab under the tiles.
    const slab = new THREE.Mesh(new THREE.BoxGeometry(size + 2.4, 3, size + 2.4), flat('#8f7fd6'))
    slab.position.y = -1.5
    slab.receiveShadow = true
    scene.add(slab)
    const lip = new THREE.Mesh(new THREE.BoxGeometry(size + 1.2, 0.2, size + 1.2), flat('#d9d2f5'))
    lip.position.y = 0.02
    lip.receiveShadow = true
    scene.add(lip)

    // Candy rail: alternating posts around the edge.
    const postGeo = new THREE.BoxGeometry(0.9, 0.7, 0.9)
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ roughness: 0.6, flatShading: true }), Math.ceil((size + 2) / 2) * 4 + 8)
    const m = new THREE.Matrix4()
    const colA = new THREE.Color('#ffffff')
    const colB = new THREE.Color('#ff8fb1')
    let k = 0
    for (let i = -1; i <= size + 1; i += 2) {
      for (const [x, z] of [[i - half, -half - 0.8], [i - half, half + 0.8], [-half - 0.8, i - half], [half + 0.8, i - half]]) {
        if (k >= posts.count) break
        m.makeTranslation(x, 0.35, z)
        posts.setMatrixAt(k, m)
        posts.setColorAt(k, (i / 2) % 2 === 0 ? colA : colB)
        k += 1
      }
    }
    posts.count = k
    posts.castShadow = true
    posts.receiveShadow = true
    scene.add(posts)

    // Floating island ring around the arena.
    const islandGeo = new THREE.CylinderGeometry(size * 0.95, size * 0.62, 10, 14, 2)
    const ip = islandGeo.attributes.position
    for (let i = 0; i < ip.count; i += 1) {
      if (ip.getY(i) < 4.9) {
        ip.setX(i, ip.getX(i) * (0.92 + rng() * 0.16))
        ip.setZ(i, ip.getZ(i) * (0.92 + rng() * 0.16))
        if (ip.getY(i) < -4.9) ip.setY(i, -5 - rng() * 6)
      }
    }
    islandGeo.computeVertexNormals()
    const island = new THREE.Mesh(islandGeo, flat('#8fd46c'))
    island.position.y = -8.2
    island.receiveShadow = true
    scene.add(island)
    const cliff = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.64, size * 0.2, 16, 12, 1), flat('#b88c66'))
    cliff.position.y = -21
    scene.add(cliff)

    // Trees and rocks on the island rim.
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 1.4, 5)
    const leafGeo = new THREE.ConeGeometry(1.4, 3, 6)
    const leafGeo2 = new THREE.IcosahedronGeometry(1.4, 0)
    const trunk = new THREE.InstancedMesh(trunkGeo, flat('#8a5a3b'), 90)
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), 90)
    const bushes = new THREE.InstancedMesh(leafGeo2, new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), 60)
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), flat('#c9c3dd'), 40)
    const q = new THREE.Quaternion()
    const v = new THREE.Vector3()
    const sc = new THREE.Vector3()
    const leafCols = ['#4fbf6a', '#3aa55c', '#7fd36b', '#ffb86b', '#ff8fa3'].map(c => new THREE.Color(c))
    const ringPoint = () => {
      const a = rng() * Math.PI * 2
      const r = half + 5 + rng() * (size * 0.34)
      return [Math.cos(a) * r, Math.sin(a) * r] as const
    }
    for (let i = 0; i < trunk.count; i += 1) {
      const [x, z] = ringPoint()
      const h = 0.8 + rng() * 0.8
      trunk.setMatrixAt(i, m.compose(v.set(x, -3.2 + 0.7 * h, z), q.identity(), sc.set(h, h, h)))
      leaves.setMatrixAt(i, m.compose(v.set(x, -3.2 + 2.6 * h, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6), sc.set(h, h, h)))
      leaves.setColorAt(i, leafCols[Math.floor(rng() * 3)])
    }
    for (let i = 0; i < bushes.count; i += 1) {
      const [x, z] = ringPoint()
      const h = 0.6 + rng() * 0.7
      bushes.setMatrixAt(i, m.compose(v.set(x, -3.1 + h * 0.6, z), q.setFromEuler(new THREE.Euler(rng(), rng() * 6, rng())), sc.set(h, h * 0.8, h)))
      bushes.setColorAt(i, leafCols[Math.floor(rng() * leafCols.length)])
    }
    for (let i = 0; i < rocks.count; i += 1) {
      const [x, z] = ringPoint()
      const h = 0.5 + rng() * 1.1
      rocks.setMatrixAt(i, m.compose(v.set(x, -3.2 + h * 0.3, z), q.setFromEuler(new THREE.Euler(rng(), rng() * 6, rng())), sc.set(h * 1.3, h, h)))
    }
    for (const mesh of [trunk, leaves, bushes, rocks]) {
      mesh.castShadow = true
      mesh.receiveShadow = true
      scene.add(mesh)
    }

    // Low-poly sea far below.
    const waterGeo = new THREE.PlaneGeometry(520, 520, 40, 40)
    waterGeo.rotateX(-Math.PI / 2)
    this.waterBase = Float32Array.from(waterGeo.attributes.position.array as Float32Array)
    this.water = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({ color: '#57c8e8', roughness: 0.35, flatShading: true, transparent: true, opacity: 0.95 }))
    this.water.position.y = -30
    scene.add(this.water)

    // Clouds.
    const puff = new THREE.IcosahedronGeometry(1, 0)
    const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true, emissive: '#dfeaff', emissiveIntensity: 0.25 })
    for (let i = 0; i < 12; i += 1) {
      const g = new THREE.Group()
      const n = 3 + Math.floor(rng() * 3)
      for (let j = 0; j < n; j += 1) {
        const p = new THREE.Mesh(puff, cloudMat)
        p.position.set(j * 1.6 - n * 0.8, rng() * 0.8, rng() * 1.2)
        p.scale.setScalar(1.2 + rng() * 1.4)
        g.add(p)
      }
      const a = rng() * Math.PI * 2
      const r = 60 + rng() * 60
      g.position.set(Math.cos(a) * r, -6 + rng() * 22, Math.sin(a) * r)
      g.scale.setScalar(1.5 + rng() * 2)
      this.clouds.add(g)
    }
    scene.add(this.clouds)
  }

  update(dt: number): void {
    this.time += dt
    const pos = this.water.geometry.attributes.position
    const base = this.waterBase
    for (let i = 0; i < pos.count; i += 1) {
      const x = base[i * 3]
      const z = base[i * 3 + 2]
      pos.setY(i, Math.sin(x * 0.08 + this.time * 0.9) * 0.9 + Math.cos(z * 0.07 + this.time * 0.7) * 0.9)
    }
    pos.needsUpdate = true
    this.water.geometry.computeVertexNormals()
    this.clouds.rotation.y += dt * 0.008
  }
}
