/**
 * Web Audio mixer with music and SFX buses. Browsers only allow audio after a user gesture, so
 * `unlock()` runs on the first key/click. Everything is synthesized: no audio files to load.
 *
 * Music is an original generative groove (kick, hats, bass and a pentatonic arp) whose tempo and
 * density follow `setIntensity()` so the last 30 seconds audibly speed up.
 */
export type Sfx = 'ui' | 'leave' | 'boost' | 'kill' | 'death' | 'nearMiss' | 'record' | 'start' | 'end' | 'tick' | 'heartbeat' | 'frenzy' | 'target'

export class Audio {
  readonly ctx: AudioContext
  private master: GainNode
  private music: GainNode
  private sfx: GainNode
  private noise: AudioBuffer
  private musicOn = false
  private timer = 0
  private nextNote = 0
  private stepIdx = 0
  private intensity = 0
  private root = 0

  constructor() {
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.music = this.ctx.createGain()
    this.sfx = this.ctx.createGain()
    const comp = this.ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.ratio.value = 4
    this.music.connect(this.master)
    this.sfx.connect(this.master)
    this.master.connect(comp).connect(this.ctx.destination)
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1
  }

  unlock(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined)
  }

  setVolumes(music: number, sfx: number, muted = false): void {
    const t = this.ctx.currentTime
    this.music.gain.setTargetAtTime(muted ? 0 : music * 0.5, t, 0.05)
    this.sfx.gain.setTargetAtTime(muted ? 0 : sfx * 0.8, t, 0.05)
  }

  private tone(freq: number, end: number, dur: number, type: OscillatorType, vol: number, delay = 0, bus: GainNode = this.sfx, at?: number): void {
    const t = (at ?? this.ctx.currentTime) + delay
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(end, 20), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(bus)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  private hiss(dur: number, vol: number, freq: number, delay = 0, bus: GainNode = this.sfx, at?: number, type: BiquadFilterType = 'highpass'): void {
    const t = (at ?? this.ctx.currentTime) + delay
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f).connect(g).connect(bus)
    src.start(t)
    src.stop(t + dur + 0.02)
  }

  play(name: Sfx): void {
    if (this.ctx.state !== 'running') return
    switch (name) {
      case 'ui': this.tone(740, 820, 0.06, 'triangle', 0.16); break
      case 'leave': this.tone(420, 560, 0.08, 'triangle', 0.08); break
      case 'boost': this.hiss(0.28, 0.18, 1200, 0, this.sfx, undefined, 'bandpass'); this.tone(260, 620, 0.22, 'sawtooth', 0.06); break
      case 'kill':
        this.tone(180, 40, 0.45, 'square', 0.22)
        this.hiss(0.4, 0.35, 600, 0, this.sfx, undefined, 'lowpass')
        ;[880, 1320, 1760].forEach((f, i) => this.tone(f, f * 1.02, 0.18, 'triangle', 0.14, 0.05 + i * 0.05))
        break
      case 'death':
        this.hiss(0.6, 0.45, 400, 0, this.sfx, undefined, 'lowpass')
        this.tone(300, 50, 0.7, 'sawtooth', 0.22)
        break
      case 'nearMiss': this.tone(1200, 500, 0.25, 'sine', 0.12); this.hiss(0.2, 0.08, 3000); break
      case 'record': [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, f, 0.22, 'square', 0.07, i * 0.07)); break
      case 'start': [392, 523, 659].forEach((f, i) => this.tone(f, f, 0.14, 'triangle', 0.18, i * 0.08)); break
      case 'end': [659, 523, 784, 1047].forEach((f, i) => this.tone(f, f * 1.01, 0.32, 'triangle', 0.2, i * 0.12)); break
      case 'tick': this.tone(1500, 1500, 0.05, 'square', 0.06); break
      case 'heartbeat': this.tone(70, 45, 0.16, 'sine', 0.35); this.tone(70, 45, 0.14, 'sine', 0.25, 0.17); break
      case 'frenzy': [330, 311, 294, 277].forEach((f, i) => this.tone(f * 2, f * 2, 0.16, 'sawtooth', 0.08, i * 0.09)); break
      case 'target': [523, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, f, 0.2, 'triangle', 0.14, i * 0.06)); break
    }
  }

  /** Capture chime: pitch rises with combo, body grows with captured size. */
  capture(cells: number, combo: number): void {
    if (this.ctx.state !== 'running') return
    const scale = [0, 2, 4, 7, 9, 12, 14, 16]
    const base = 523.25 * Math.pow(2, scale[Math.min(scale.length - 1, Math.max(0, combo - 1))] / 12)
    const big = Math.min(1, cells / 250)
    this.tone(base, base * 1.5, 0.12, 'triangle', 0.22)
    this.tone(base * 1.5, base * 2, 0.2, 'sine', 0.18, 0.06)
    this.hiss(0.18 + big * 0.35, 0.08 + big * 0.2, 2500 - big * 1500)
    if (big > 0.2) {
      this.tone(base / 2, base / 4, 0.5 * big + 0.2, 'sine', 0.3 * big)
      ;[1, 1.25, 1.5, 2].forEach((m, i) => this.tone(base * m, base * m, 0.16, 'square', 0.05 * big, 0.12 + i * 0.05))
    }
  }

  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v))
  }

  startMusic(): void {
    if (this.musicOn) return
    this.musicOn = true
    this.nextNote = this.ctx.currentTime + 0.1
    this.stepIdx = 0
    const tick = () => {
      if (!this.musicOn) return
      const bpm = 108 + this.intensity * 30
      const sixteenth = 60 / bpm / 4
      while (this.nextNote < this.ctx.currentTime + 0.12) {
        this.scheduleStep(this.stepIdx, this.nextNote)
        this.nextNote += sixteenth
        this.stepIdx += 1
      }
      this.timer = window.setTimeout(tick, 30)
    }
    tick()
  }

  private scheduleStep(i: number, t: number): void {
    const s = i % 16
    const bar = Math.floor(i / 16)
    // Chord roots cycle every 2 bars: I – vi – IV – V in C.
    const roots = [0, -3, 5, 7]
    this.root = roots[Math.floor(bar / 2) % roots.length]
    const hz = (semi: number) => 261.63 * Math.pow(2, semi / 12)
    const bus = this.music
    const heat = this.intensity
    if (s % 4 === 0) {
      this.tone(150, 45, 0.18, 'sine', 0.5, 0, bus, t)
    }
    if (s === 4 || s === 12) this.hiss(0.12, 0.12 + heat * 0.06, 1800, 0, bus, t, 'bandpass')
    if (s % 2 === 1 || (heat > 0.6 && s % 1 === 0)) this.hiss(0.03, 0.035 + heat * 0.03, 7000, 0, bus, t)
    if (s % 4 === 2 || s === 0) this.tone(hz(this.root - 24), hz(this.root - 24), 0.16, 'triangle', 0.28, 0, bus, t)
    const penta = [0, 2, 4, 7, 9, 12, 14, 16]
    const pattern = [0, 2, 4, 5, 3, 4, 6, 7, 5, 4, 2, 3, 1, 2, 4, 6]
    if (s % 2 === 0 || heat > 0.45) {
      const note = penta[pattern[(s + bar * 3) % 16] % penta.length] + this.root
      this.tone(hz(note), hz(note), 0.1, 'square', 0.035 + heat * 0.02, 0, bus, t)
    }
  }

  stopMusic(): void {
    this.musicOn = false
    clearTimeout(this.timer)
  }
}
