// Automated playtest against the running dev server (http://127.0.0.1:3000).
// Usage: node scripts/playtest.mjs [outDir] [mode]
//  mode = full (default) | mobile
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const out = process.argv[2] ?? '/tmp/shots'
const mode = process.argv[3] ?? 'full'
const base = process.env.URL ?? 'http://127.0.0.1:3000/'
mkdirSync(out, { recursive: true })
const errors = []
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] })
const mobile = mode === 'mobile'
const ctx = await browser.newContext(mobile ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, locale: 'zh-CN' } : { viewport: { width: 1280, height: 720 }, locale: process.env.LOCALE ?? 'zh-CN' })
const page = await ctx.newPage()
page.on('console', m => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`)
})
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
await page.goto(base + (process.env.QS ?? ''))
await page.waitForFunction(() => document.getElementById('ui')?.dataset.view === 'title', null, { timeout: 60000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${out}/01-title.png` })

const state = () => page.evaluate(() => {
  const g = window.__game.game
  const a = g.arena
  const p = a.player
  return { mode: g.mode, t: a.time, bp: a.bpOf(0), alive: p.alive, outside: p.outside, x: p.x, z: p.z, heading: p.heading, trail: p.trail.length, score: g.liveScore(), screen: window.__game.ui.screen }
})

if (mobile) {
  await page.tap('.btn-play', { force: true })
} else {
  await page.keyboard.press('Enter')
}
await page.waitForTimeout(600)
await page.screenshot({ path: `${out}/02-start.png` })

if (process.env.BOT) {
  // Let an AI brain drive the player for a full, legitimate 90 s run (balance + submission check).
  await page.evaluate(async kind => {
    const { Brain } = await import('/src/game/ai.ts')
    const g = window.__game.game
    const brain = new Brain(kind, Math.random)
    g.steerPlayer = function () {
      const a = this.arena
      a.playerInput = brain.decide(a.player, a, 1 / 60)
    }
  }, process.env.BOT)
}
// Simple bot: drive out for a while, turn 90° three times to form a loop and come back.
const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']
let shot = 3
let firstCapture = null
const t0 = Date.now()
let dir = 0
let lastBp = 0
while (Date.now() - t0 < (Number(process.env.PLAY_MS) || 30000)) {
  const s = await state()
  if (s.mode !== 'playing') break
  if (s.bp > lastBp + 5 && firstCapture === null && s.bp > 400) firstCapture = s.t
  lastBp = s.bp
  const k = keys[dir % 4]
  if (process.env.BOT) {
    await page.waitForTimeout(1000)
    if (s.t > 5 && s.t < 7 && shot < 7) await page.screenshot({ path: `${out}/0${shot++}-play.png` })
    if (s.t > 45 && shot < 7) await page.screenshot({ path: `${out}/0${shot++}-play.png` })
    continue
  }
  if (!mobile) {
    await page.keyboard.down(k)
    await page.waitForTimeout(s.outside ? 700 : 450)
    await page.keyboard.up(k)
  } else {
    await page.waitForTimeout(600)
  }
  dir += 1
  if (dir % 6 === 0 && shot < 7) await page.screenshot({ path: `${out}/0${shot++}-play.png` })
}
const s = await state()
console.log('state after play', JSON.stringify(s), 'firstCaptureAt', firstCapture)
if (s.mode === 'playing' && !process.env.BOT) {
  // Fast-forward: let the clock run out.
  await page.evaluate(() => { window.__game.game.arena.time = 89.5 })
}
await page.waitForFunction(() => window.__game.ui.screen === 'results', null, { timeout: 120000 })
await page.waitForTimeout(2500)
await page.screenshot({ path: `${out}/08-results.png` })
const rank = await page.evaluate(() => document.getElementById('r-rank').textContent)
console.log('rank text:', rank)
if (!mobile) {
  await page.click('[data-act="share"]')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${out}/09-share.png` })
  const img = await page.evaluate(() => document.getElementById('sh-img').src)
  if (img.startsWith('blob:')) {
    const data = await page.evaluate(async src => {
      const b = await (await fetch(src)).blob()
      const r = new FileReader()
      return await new Promise(res => { r.onload = () => res(r.result); r.readAsDataURL(b) })
    }, img)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${out}/card.png`, Buffer.from(String(data).split(',')[1], 'base64'))
  }
  console.log('share url:', await page.evaluate(() => document.getElementById('sh-url').value))
  await page.click('.modal.active [data-act="close"]')
  await page.click('.results [data-act="board"]')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${out}/10-board.png` })
  await page.click('.tabs [data-period="all"]')
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/11-board-all.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.keyboard.press('Space')
  await page.waitForTimeout(800)
  console.log('after space restart:', JSON.stringify(await state()))
}
console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none')
await browser.close()
