import './styles/main.css'
import { Audio } from './engine/audio'
import { I18n, resolveLocale } from './engine/i18n'
import { Input } from './engine/input'
import { GameLoop } from './engine/loop'
import { SAVE_KEY, SaveStore, type SaveData } from './engine/save'
import type { Game } from './game/game'
import { daySeed, utcDay } from './game/rng'
import { formatPct, type RunResult } from './game/rules'
import { ApiError, LeaderboardClient, type SubmitReceipt } from './net/api'
import { canvasBlob, challengeUrl, copyText, readChallenge, renderCard } from './net/share'
import { TouchControls } from './ui/touch'
import { Ui, type Target } from './ui/ui'

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const firstRun = safeGet(SAVE_KEY) === null
  const save = new SaveStore()
  const i18n = new I18n(resolveLocale(save.data.locale, navigator.languages))
  const input = new Input(canvas)
  const audio = new Audio()
  const api = new LeaderboardClient(save)
  let game: Game | undefined
  let touch: TouchControls | undefined
  let loop: GameLoop | undefined
  let target: Target = null
  let runTicket: Promise<{ runId: string } | null> | null = null
  let lastResult: RunResult | null = null
  let lastReceipt: SubmitReceipt | null = null
  let lastOwner: Int8Array | null = null
  let lastColors: string[] = []
  let cardUrl: string | null = null

  const applySettings = (d: SaveData) => {
    audio.setVolumes(d.musicVolume, d.sfxVolume, d.muted)
    if (game) game.reducedMotion = d.reducedMotion
  }

  const startRun = () => {
    if (!game) return
    audio.unlock()
    audio.startMusic()
    ui.closeModal()
    lastResult = null
    lastReceipt = null
    game.targetScore = target?.score ?? 0
    game.bestScore = save.data.bestScore
    game.tutorial = !save.data.tutorialDone
    ui.setTarget(target, save.data.bestScore)
    // Daily Arena: everyone gets the same layout and rival line-up for the UTC day.
    game.start(daySeed(utcDay()))
    ui.show('hud')
    touch?.setVisible(true)
    loop?.resetAccumulator()
    // Ask the server for a run ticket right away; it times the run for anti-cheat checks.
    runTicket = api.startRun().catch(() => null)
  }

  const pause = () => {
    if (game?.mode !== 'playing') return
    game.pause()
    ui.show('pause')
    touch?.setVisible(false)
  }
  const resume = () => {
    if (game?.mode !== 'paused') return
    game.resume()
    ui.closeModal()
    ui.show('hud')
    touch?.setVisible(true)
    loop?.resetAccumulator()
  }
  const toTitle = () => {
    game?.toAttract()
    ui.closeModal()
    ui.show('title')
    touch?.setVisible(false)
  }

  const onEnd = async (result: RunResult) => {
    if (!game) return
    touch?.setVisible(false)
    lastResult = result
    lastOwner = game.finalOwner()
    lastColors = game.arena.entities.map(e => e.color)
    const rec = save.recordRun(result.score, result.territoryBp, utcDay())
    ui.showResults(result, rec.allTime && rec.previousBest > 0, rec.previousBest)
    if (rec.allTime && rec.previousBest > 0) audio.play('record')
    const ticket = await (runTicket ?? Promise.resolve(null))
    if (lastResult !== result) return
    if (!ticket) {
      ui.setSubmit({ kind: 'offline' })
      return
    }
    if (result.durationMs < 1000) {
      ui.setSubmit({ kind: 'rejected' })
      return
    }
    try {
      const receipt = await api.submit(ticket.runId, result)
      if (lastResult !== result) return
      lastReceipt = receipt
      ui.setSubmit({ kind: 'ok', receipt })
    } catch (err) {
      const rejected = err instanceof ApiError && err.status >= 400 && err.status < 500
      ui.setSubmit({ kind: rejected ? 'rejected' : 'offline' })
      if (rejected) console.warn('leaderboard rejected run:', (err as ApiError).code)
    }
  }

  const displayName = () => save.data.playerName || save.data.guest?.name || ''
  const shareLink = () => {
    const score = lastResult?.score ?? save.data.bestScore
    const runId = lastReceipt?.accepted ? lastReceipt.runId : null
    return challengeUrl(runId, score, displayName())
  }

  const ui = new Ui(i18n, save, audio, input, {
    play: startRun,
    restart: startRun,
    resume,
    quit: toTitle,
    settings: patch => {
      const qualityChanged = patch.quality !== undefined && patch.quality !== save.data.quality
      save.update(patch)
      applySettings(save.data)
      if (patch.locale) {
        i18n.set(patch.locale)
        game?.relabel()
      }
      if (qualityChanged) game?.setQuality(save.data.quality)
    },
    rename: async name => {
      save.update({ playerName: name })
      try {
        if (save.data.guest) await api.rename(name)
        else await api.guest()
        return true
      } catch (err) {
        if (err instanceof ApiError && err.code === 'invalid_display_name') return false
        // Offline: keep the local name; it is registered with the next run.
        return true
      }
    },
    loadBoard: period => api.board(period),
    share: async () => {
      if (!lastResult || !lastOwner) return null
      const url = shareLink()
      const r = lastResult
      const zh = i18n.locale === 'zh-CN'
      const card = await renderCard({
        title: zh ? '圈地大作战' : 'PAINT GRAB',
        subtitle: zh ? 'PAINT GRAB' : 'Loop it. Grab it. Keep it.',
        score: r.score,
        scoreLabel: i18n.t('share.cardScore'),
        rankLine: lastReceipt ? i18n.t('share.cardRank', { rank: lastReceipt.today.rank, pct: lastReceipt.all.beatPercent }) : i18n.t('share.cardNoRank'),
        land: i18n.t('share.cardLand', { pct: formatPct(r.territoryBp) }),
        kills: i18n.t('share.cardKills', { n: r.kills }),
        cta: i18n.t('share.cardCta'),
        day: i18n.t('share.cardDay', { day: utcDay() }),
        url,
        name: displayName(),
        owner: lastOwner,
        size: Math.round(Math.sqrt(lastOwner.length)),
        colors: lastColors,
        playerColor: lastColors[0] ?? '#ff4f7b',
      })
      const blob = await canvasBlob(card)
      if (cardUrl) URL.revokeObjectURL(cardUrl)
      cardUrl = URL.createObjectURL(blob)
      return { blobUrl: cardUrl, url, text: i18n.t('share.text', { score: r.score, url }), blob }
    },
    copyChallenge: () => {
      const url = shareLink()
      const score = lastResult?.score ?? save.data.bestScore
      return copyText(i18n.t('share.text', { score, url }))
    },
  })
  ui.show('boot')
  applySettings(save.data)

  // Challenge link: the server-verified run wins; URL numbers are only an offline preview.
  const ch = readChallenge()
  if (ch) {
    target = ch.score > 0 ? { name: ch.name || '???', score: ch.score } : null
    ui.setTarget(target, save.data.bestScore)
    if (ch.runId) {
      api.challenge(ch.runId).then(
        c => {
          target = { name: c.displayName, score: c.score }
          ui.setTarget(target, save.data.bestScore)
          if (game) game.targetScore = c.score
        },
        err => {
          // Unknown run id means a forged or broken link: drop the target instead of trusting it.
          if (err instanceof ApiError && err.status === 404) {
            target = null
            ui.setTarget(null, save.data.bestScore)
          }
        },
      )
    }
  }

  let loaded = 0
  const track = <T>(p: Promise<T>): Promise<T> => p.then(v => (ui.setBootProgress(0.1 + (++loaded / 4) * 0.9), v))
  ui.setBootProgress(0.1)
  const [{ Game }, { Renderer, suggestQuality }, physics] = await Promise.all([
    track(import('./game/game')),
    track(import('./engine/renderer')),
    track(import('./engine/physics')),
    track(document.fonts.ready),
  ])
  await physics.initPhysics()
  if (firstRun) {
    save.update({ quality: suggestQuality() })
    ui.refreshSettings()
  }
  const renderer = new Renderer(canvas, save.data.quality)
  const lang = () => (i18n.locale === 'zh-CN' ? 'zh' : 'en') as 'en' | 'zh'
  const g = new Game(
    renderer,
    input,
    audio,
    {
      popup: (text, at, kind) => ui.popup(text, at, kind),
      banner: (key, kind) => ui.banner(key, kind),
      feed: (k, v, reason) => ui.feed(k, v, reason),
      flash: kind => ui.flash(kind),
      end: result => void onEnd(result),
      firstCapture: () => save.update({ tutorialDone: true }),
    },
    { t: (k, v) => i18n.t(k, v), lang },
  )
  game = g
  g.reducedMotion = save.data.reducedMotion
  g.setQuality(save.data.quality)
  touch = new TouchControls(document.getElementById('ui')!, input, () => g.mode === 'playing', i18n)

  const mainLoop = new GameLoop({
    step: dt => g.step(dt),
    render: (alpha, frameSeconds) => {
      input.update()
      if (input.consume('pause')) {
        if (ui.modal) ui.closeModal()
        else if (g.mode === 'playing') pause()
        else if (g.mode === 'paused') resume()
      }
      if (input.consume('back') && ui.modal) ui.closeModal()
      if (input.pressed('confirm') && !ui.modal) {
        if (ui.screen === 'title') {
          input.consume('boost')
          startRun()
        } else if (ui.screen === 'results' && ui.resultsReady()) {
          input.consume('boost')
          startRun()
        } else if (ui.screen === 'pause') resume()
      }
      input.consume('confirm')
      mainLoop.paused = g.mode === 'paused'
      g.render(alpha, frameSeconds)
      if (ui.screen === 'hud') {
        const h = g.hud()
        const p = g.arena.player
        const hint = g.tutorial && !save.data.tutorialDone ? i18n.t('hud.hint') : p.outside && (h.danger > 0.5 || p.trail.length > 34) ? i18n.t('hud.out') : ''
        ui.updateHud(h, hint)
      }
      input.endFrame()
    },
  })
  loop = mainLoop
  mainLoop.start()

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause()
  })
  window.addEventListener('game:pause', pause)
  window.addEventListener('pointerdown', () => audio.unlock(), { once: true })
  window.addEventListener('keydown', () => audio.unlock(), { once: true })
  window.setTimeout(() => ui.show('title'), 200)
  // Debug/test hook (read-only use): smoke tests inspect run state through it.
  ;(window as unknown as { __game: unknown }).__game = { game: g, ui, input, save, api, start: startRun }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

boot().catch(err => {
  console.error(err)
  const el = document.getElementById('ui')
  if (el) el.innerHTML = `<div class="fatal">Failed to start: ${String((err as Error)?.message ?? err).replace(/[<>&]/g, '')}</div>`
})
