import * as THREE from 'three'
import type { PersonalityId } from './config'

const flat = (color: THREE.ColorRepresentation, emissive = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.55, flatShading: true, emissive: color, emissiveIntensity: emissive })

function label(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 80
  const ctx = canvas.getContext('2d')!
  ctx.font = '900 44px "Game Display", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 12
  ctx.strokeStyle = '#1d1640'
  ctx.strokeText(text, 128, 42)
  ctx.fillStyle = color
  ctx.fillText(text, 128, 42)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
  sprite.scale.set(2.6, 0.81, 1)
  sprite.renderOrder = 10
  return sprite
}

/**
 * One contestant: a chunky hex "slider" puck with a gem body, big eyes and a personality
 * accessory (horns = aggressive, round ears = timid, crown = greedy, star antenna = player).
 */
export class Avatar {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly tag: THREE.Sprite
  private readonly ring?: THREE.Mesh
  private bank = 0
  private lastHeading = 0
  private spawnT = 1
  private squash = 0

  constructor(color: string, personality: PersonalityId, name: string) {
    const c = new THREE.Color(color)
    const dark = c.clone().multiplyScalar(0.55)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.26, 6), flat(dark))
    base.position.y = 0.13
    base.castShadow = true
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.06, 6), flat('#ffffff', 0.3))
    skirt.position.y = 0.03
    const gem = new THREE.Mesh(new THREE.IcosahedronGeometry(0.48, 0), flat(color, 0.08))
    gem.scale.set(1, 0.82, 1)
    gem.position.y = 0.58
    gem.castShadow = true
    this.body.add(base, skirt, gem)
    // Eyes look along +x (forward).
    const white = flat('#ffffff', 0.2)
    const black = flat('#1d1640')
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), white)
      eye.position.set(0.36, 0.66, side * 0.17)
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 4), black)
      pupil.position.set(0.48, 0.66, side * 0.17)
      this.body.add(eye, pupil)
    }
    if (personality === 'aggressive') {
      const horn = flat('#3b1030')
      for (const side of [-1, 1]) {
        const h = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.34, 5), horn)
        h.position.set(0.08, 1.0, side * 0.24)
        h.rotation.x = side * 0.45
        this.body.add(h)
      }
      // Angry brows.
      for (const side of [-1, 1]) {
        const brow = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.2), black)
        brow.position.set(0.44, 0.84, side * 0.17)
        brow.rotation.x = side * 0.5
        this.body.add(brow)
      }
    } else if (personality === 'timid') {
      for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(0.14, 7, 5), flat(c.clone().offsetHSL(0, 0, 0.12)))
        ear.position.set(-0.05, 0.98, side * 0.28)
        this.body.add(ear)
      }
      const blush = flat('#ff9db5')
      for (const side of [-1, 1]) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), blush)
        b.position.set(0.4, 0.5, side * 0.3)
        b.scale.set(0.5, 0.6, 1)
        this.body.add(b)
      }
    } else if (personality === 'greedy') {
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.2, 6, 1, true), flat('#ffd23f', 0.35))
      crown.position.set(-0.02, 1.02, 0)
      this.body.add(crown)
      for (let i = 0; i < 6; i += 1) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 4), flat('#ffd23f', 0.35))
        const a = (i / 6) * Math.PI * 2
        spike.position.set(-0.02 + Math.cos(a) * 0.23, 1.17, Math.sin(a) * 0.23)
        this.body.add(spike)
      }
    } else {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 5), black)
      stalk.position.set(-0.05, 1.08, 0)
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), flat('#fff27a', 1.2))
      star.position.set(-0.05, 1.32, 0)
      star.name = 'star'
      this.body.add(stalk, star)
      this.ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.15, 24), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, depthWrite: false }))
      this.ring.rotation.x = -Math.PI / 2
      this.ring.position.y = 0.06
      this.root.add(this.ring)
    }
    this.root.add(this.body)
    this.tag = label(name, personality === 'player' ? '#fff27a' : '#ffffff')
    this.tag.position.y = 2.05
    this.root.add(this.tag)
  }

  setName(name: string, isPlayer: boolean): void {
    const next = label(name, isPlayer ? '#fff27a' : '#ffffff')
    ;(this.tag.material as THREE.SpriteMaterial).map?.dispose()
    ;(this.tag.material as THREE.SpriteMaterial).map = (next.material as THREE.SpriteMaterial).map
  }

  spawn(): void {
    this.spawnT = 0
  }
  boost(): void {
    this.squash = 1
  }

  update(x: number, y: number, z: number, heading: number, dt: number, time: number, visible: boolean, boosting: boolean): void {
    this.root.visible = visible
    if (!visible) return
    this.root.position.set(x, y, z)
    let turn = heading - this.lastHeading
    turn = Math.atan2(Math.sin(turn), Math.cos(turn))
    this.lastHeading = heading
    const targetBank = Math.max(-0.5, Math.min(0.5, (turn / Math.max(dt, 1e-3)) * 0.06))
    this.bank += (targetBank - this.bank) * Math.min(1, dt * 10)
    this.body.rotation.set(this.bank, -heading, 0, 'YXZ')
    this.body.rotation.order = 'YXZ'
    this.spawnT = Math.min(1, this.spawnT + dt * 2.5)
    this.squash = Math.max(0, this.squash - dt * 3)
    const pop = this.spawnT < 1 ? 1 + Math.sin(this.spawnT * Math.PI) * 0.5 - (1 - this.spawnT) * 0.6 : 1
    const bob = Math.sin(time * 9) * 0.04
    const sq = this.squash * 0.25 + (boosting ? 0.08 : 0)
    this.body.scale.set(pop * (1 + sq), pop * (1 - sq * 0.8) + bob, pop * (1 + sq * 0.4))
    const star = this.body.getObjectByName('star')
    if (star) star.rotation.y = time * 3
    if (this.ring) {
      const s = 1 + Math.sin(time * 5) * 0.08
      this.ring.scale.set(s, s, s)
    }
  }

  dispose(): void {
    this.root.traverse(o => {
      const mesh = o as THREE.Mesh
      mesh.geometry?.dispose?.()
    })
  }
}
