// End-to-end smoke test against the production build (run `vite build` first).
// Serves dist/ with `vite preview`, boots the game in headless Chromium in English and Chinese,
// plays a few seconds, walks pause/settings/quality/language, ends a run and restarts with Space.
// Fails on any console error (leaderboard API calls are tolerated: preview has no backend).
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
let browser
const guard = setTimeout(() => fail('timed out'), 150_000)
function cleanup() {
  clearTimeout(guard)
  try { server.kill('SIGTERM') } catch {}
}
async function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`)
  await browser?.close().catch(() => {})
  cleanup()
  process.exit(1)
}
async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('preview server did not start')
}
const apiNoise = t => /\/api\/|Failed to load resource|leaderboard/i.test(t)
async function openGame(locale, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale })
  const page = await context.newPage()
  page.on('console', m => m.type() === 'error' && !apiNoise(m.text()) && errors.push(m.text()))
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => document.getElementById('ui')?.dataset.view === 'title', null, { timeout: 60_000 })
  await page.waitForTimeout(800)
  return page
}
const state = page => page.evaluate(() => {
  const g = window.__game.game
  const p = g.arena.player
  return { mode: g.mode, screen: window.__game.ui.screen, t: g.arena.time, x: p.x, z: p.z, lang: document.documentElement.lang }
})

try {
  await waitForServer()
  browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] })
  const errors = []
  const page = await openGame('en-US', errors)
  if ((await state(page)).lang !== 'en') throw new Error('expected English for en-US')
  await page.screenshot({ path: `${out}/01-title-en.png` })
  const before = await state(page)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  await page.keyboard.down('ArrowDown')
  await page.waitForTimeout(900)
  await page.keyboard.up('ArrowDown')
  await page.keyboard.down('ArrowLeft')
  await page.waitForTimeout(700)
  await page.keyboard.up('ArrowLeft')
  const after = await state(page)
  await page.screenshot({ path: `${out}/02-gameplay.png` })
  if (after.mode !== 'playing') throw new Error(`expected playing, got ${after.mode}`)
  const moved = Math.hypot(after.x - before.x, after.z - before.z)
  if (moved < 2) throw new Error(`player barely moved (${moved.toFixed(2)})`)
  console.log(`smoke: moved ${moved.toFixed(1)} cells, clock ${after.t.toFixed(1)} s`)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const ps = await state(page)
  if (ps.mode !== 'paused') throw new Error('Escape did not pause: ' + JSON.stringify(ps))
  await page.screenshot({ path: `${out}/03-pause.png` })
  await page.click('.pause [data-act="settings"]')
  await page.waitForTimeout(300)
  await page.click('#s-quality [data-q="low"]')
  await page.click('#s-lang [data-l="zh-CN"]')
  await page.waitForTimeout(300)
  if ((await state(page)).lang !== 'zh-CN') throw new Error('language toggle failed')
  await page.screenshot({ path: `${out}/04-settings.png` })
  await page.click('#s-lang [data-l="en"]')
  await page.click('#s-quality [data-q="high"]')
  await page.click('.modal.active [data-act="close"]')
  await page.click('.pause [data-act="resume"]')
  await page.waitForTimeout(300)
  if ((await state(page)).mode !== 'playing') throw new Error('resume failed')

  // End the run (fast-forward the clock; the offline preview has no leaderboard to reject it).
  await page.evaluate(() => { window.__game.game.arena.time = 89.8 })
  await page.waitForFunction(() => window.__game.ui.screen === 'results', null, { timeout: 15_000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${out}/05-results.png` })
  await page.keyboard.press('Space')
  await page.waitForTimeout(500)
  const re = await state(page)
  if (re.mode !== 'playing' || re.t > 2) throw new Error(`Space did not restart (${re.mode} t=${re.t})`)

  const zhErrors = []
  const zh = await openGame('zh-CN', zhErrors)
  if ((await state(zh)).lang !== 'zh-CN') throw new Error('expected Chinese for zh-CN')
  await zh.screenshot({ path: `${out}/06-title-zh.png` })
  errors.push(...zhErrors)
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`)
  console.log('smoke: OK')
  await browser.close()
  cleanup()
  process.exit(0)
} catch (e) {
  await fail(e instanceof Error ? e.message : String(e))
}
