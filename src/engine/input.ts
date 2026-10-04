/**
 * Unified input: keyboard, mouse, gamepad and touch feed one action state. Gameplay reads
 * `move` (steer intent), `pressed()/held()` for actions and `pointer` for mouse steering.
 *
 * Controls are deliberately tiny: a direction plus one boost button.
 */
export type Action = 'boost' | 'pause' | 'confirm' | 'back'
export type InputMethod = 'keyboard' | 'mouse' | 'gamepad' | 'touch'

const KEY_BINDINGS: Record<Action, string[]> = {
  boost: ['Space', 'ShiftLeft', 'ShiftRight', 'KeyJ', 'KeyK'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'NumpadEnter', 'Space'],
  back: [],
}
const MOVE_KEYS = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] }
// Standard gamepad mapping: A=0, B=1, X=2, Y=3, LB=4, RB=5, LT=6, RT=7, Start=9.
const PAD_BINDINGS: Record<Action, number[]> = { boost: [0, 2, 5, 7], pause: [9], confirm: [0, 9], back: [1] }

export class Input {
  /** Steering intent in [-1, 1]: x = screen right, y = screen up. */
  readonly move = { x: 0, y: 0 }
  /** Last mouse position in CSS pixels, and whether mouse steering is active. */
  readonly pointer = { x: 0, y: 0, active: false }
  method: InputMethod = 'keyboard'
  private keys = new Set<string>()
  private held_ = new Set<Action>()
  private pressed_ = new Set<Action>()
  private touchMove = { x: 0, y: 0 }
  private touchButtons = new Set<Action>()
  private mouseDown = false
  private padPrev = new Set<Action>()
  private listeners: Array<() => void> = []
  /** Some listeners (menus) want raw key events; they read these. */
  onAnyKey?: (code: string) => void

  constructor(readonly canvas: HTMLCanvasElement) {
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts)
      this.listeners.push(() => target.removeEventListener(type, fn as EventListener, opts))
    }
    on(window, 'keydown', e => {
      const typing = (e.target as HTMLElement | null)?.matches?.('input, textarea')
      if (typing) return
      if (e.repeat) {
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
        return
      }
      this.keys.add(e.code)
      this.method = 'keyboard'
      if (Object.values(MOVE_KEYS).some(list => list.includes(e.code))) this.pointer.active = false
      for (const [action, codes] of Object.entries(KEY_BINDINGS) as [Action, string[]][]) {
        if (codes.includes(e.code)) this.pressed_.add(action)
      }
      this.onAnyKey?.(e.code)
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
    })
    on(window, 'keyup', e => this.keys.delete(e.code))
    on(window, 'blur', () => {
      this.keys.clear()
      this.mouseDown = false
    })
    on(canvas, 'mousemove', e => {
      const dx = e.clientX - this.pointer.x
      const dy = e.clientY - this.pointer.y
      this.pointer.x = e.clientX
      this.pointer.y = e.clientY
      // Ignore tiny jitter so a resting mouse doesn't steal control from the keyboard.
      if (Math.hypot(dx, dy) > 3 && this.method !== 'touch') {
        this.pointer.active = true
        this.method = 'mouse'
      }
    })
    on(canvas, 'mousedown', e => {
      if (e.button !== 0) return
      this.pointer.x = e.clientX
      this.pointer.y = e.clientY
      this.pointer.active = true
      this.method = 'mouse'
      this.mouseDown = true
      this.pressed_.add('boost')
    })
    on(window, 'mouseup', () => (this.mouseDown = false))
    on(canvas, 'mouseleave', () => (this.pointer.active = false))
    on(canvas, 'contextmenu', e => e.preventDefault())
  }

  /** Touch controls feed these from the on-screen joystick and buttons. */
  setTouchMove(x: number, y: number): void {
    this.method = 'touch'
    this.pointer.active = false
    this.touchMove.x = x
    this.touchMove.y = y
  }
  setTouchButton(action: Action, down: boolean): void {
    this.method = 'touch'
    if (down && !this.touchButtons.has(action)) this.pressed_.add(action)
    if (down) this.touchButtons.add(action)
    else this.touchButtons.delete(action)
  }

  /** Sample continuous sources. Call once per rendered frame before gameplay reads input. */
  update(): void {
    const k = (codes: string[]) => codes.some(code => this.keys.has(code))
    let x = (k(MOVE_KEYS.right) ? 1 : 0) - (k(MOVE_KEYS.left) ? 1 : 0)
    let y = (k(MOVE_KEYS.up) ? 1 : 0) - (k(MOVE_KEYS.down) ? 1 : 0)
    this.held_.clear()
    for (const [action, codes] of Object.entries(KEY_BINDINGS) as [Action, string[]][]) {
      if (k(codes)) this.held_.add(action)
    }
    if (this.mouseDown) this.held_.add('boost')
    for (const action of this.touchButtons) this.held_.add(action)
    if (this.touchMove.x !== 0 || this.touchMove.y !== 0) {
      x = this.touchMove.x
      y = this.touchMove.y
    }
    const pad = navigator.getGamepads?.().find(p => p && p.connected)
    if (pad) {
      const dead = (v: number) => (Math.abs(v) < 0.22 ? 0 : v)
      let lx = dead(pad.axes[0] ?? 0)
      let ly = dead(pad.axes[1] ?? 0)
      // D-pad (buttons 12-15) steers too.
      if (pad.buttons[12]?.pressed) ly = -1
      if (pad.buttons[13]?.pressed) ly = 1
      if (pad.buttons[14]?.pressed) lx = -1
      if (pad.buttons[15]?.pressed) lx = 1
      const padActive = lx !== 0 || ly !== 0 || pad.buttons.some(b => b.pressed)
      if (padActive) {
        this.method = 'gamepad'
        this.pointer.active = false
      }
      if (lx !== 0 || ly !== 0) {
        x = lx
        y = -ly
      }
      const now = new Set<Action>()
      for (const [action, buttons] of Object.entries(PAD_BINDINGS) as [Action, number[]][]) {
        if (buttons.some(i => pad.buttons[i]?.pressed)) now.add(action)
      }
      for (const action of now) {
        this.held_.add(action)
        if (!this.padPrev.has(action)) this.pressed_.add(action)
      }
      this.padPrev = now
    }
    if (x !== 0 || y !== 0) this.pointer.active = false
    const len = Math.hypot(x, y)
    this.move.x = len > 1 ? x / len : x
    this.move.y = len > 1 ? y / len : y
  }

  held(action: Action): boolean {
    return this.held_.has(action)
  }
  pressed(action: Action): boolean {
    return this.pressed_.has(action)
  }
  /** Read and clear a press (use inside fixed steps so one press triggers once). */
  consume(action: Action): boolean {
    return this.pressed_.delete(action)
  }
  endFrame(): void {
    this.pressed_.clear()
  }
  dispose(): void {
    for (const off of this.listeners) off()
    this.listeners = []
  }
}
