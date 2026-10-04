import type { Input } from '../engine/input'
import type { I18n } from '../engine/i18n'

/**
 * On-screen controls for touch devices: a floating joystick anywhere on the left 60% of the
 * screen and a big BOOST button on the right. Shown only while a match is running.
 */
export class TouchControls {
  private readonly el: HTMLElement
  private readonly knob: HTMLElement
  private readonly base: HTMLElement
  private stickId: number | null = null
  private ox = 0
  private oy = 0

  constructor(parent: HTMLElement, private readonly input: Input, private readonly active: () => boolean, i18n: I18n) {
    this.el = document.createElement('div')
    this.el.className = 'touch'
    this.el.innerHTML = `<div class="stick-zone"><div class="stick-base"><div class="stick-knob"></div></div></div><button class="touch-boost" aria-label="boost"><span></span></button>`
    parent.appendChild(this.el)
    this.base = this.el.querySelector('.stick-base')!
    this.knob = this.el.querySelector('.stick-knob')!
    const label = this.el.querySelector('.touch-boost span')!
    const setLabel = () => (label.textContent = i18n.t('touch.boost'))
    setLabel()
    i18n.onChange(setLabel)
    const zone = this.el.querySelector<HTMLElement>('.stick-zone')!
    zone.addEventListener('pointerdown', e => {
      if (!this.active() || this.stickId !== null) return
      this.stickId = e.pointerId
      zone.setPointerCapture(e.pointerId)
      this.ox = e.clientX
      this.oy = e.clientY
      this.base.style.left = `${e.clientX}px`
      this.base.style.top = `${e.clientY}px`
      this.base.classList.add('on')
      this.knob.style.transform = 'translate(-50%, -50%)'
    })
    zone.addEventListener('pointermove', e => {
      if (e.pointerId !== this.stickId) return
      const max = 56
      let dx = e.clientX - this.ox
      let dy = e.clientY - this.oy
      const len = Math.hypot(dx, dy)
      if (len > max) {
        dx = (dx / len) * max
        dy = (dy / len) * max
      }
      this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
      if (len > 8) this.input.setTouchMove(dx / max, -dy / max)
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return
      this.stickId = null
      this.base.classList.remove('on')
      // Keep the last heading: the slider always moves, releasing just stops steering.
      this.input.setTouchMove(0, 0)
    }
    zone.addEventListener('pointerup', end)
    zone.addEventListener('pointercancel', end)
    const boost = this.el.querySelector<HTMLButtonElement>('.touch-boost')!
    boost.addEventListener('pointerdown', e => {
      e.preventDefault()
      this.input.setTouchButton('boost', true)
      boost.classList.add('down')
    })
    const up = () => {
      this.input.setTouchButton('boost', false)
      boost.classList.remove('down')
    }
    boost.addEventListener('pointerup', up)
    boost.addEventListener('pointercancel', up)
    boost.addEventListener('pointerleave', up)
    window.addEventListener('touchstart', () => document.body.classList.add('touch-device'), { once: true, passive: true })
    if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch-device')
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('show', v)
    if (!v && this.stickId !== null) {
      this.stickId = null
      this.base.classList.remove('on')
      this.input.setTouchMove(0, 0)
    }
  }
}
