import type { Audio } from '../engine/audio'
import type { I18n } from '../engine/i18n'
import type { Input } from '../engine/input'
import { cleanName, type Locale, type Quality, type SaveData, type SaveStore } from '../engine/save'
import type { HudState, PopupKind } from '../game/game'
import { formatClock, formatPct, type RunResult } from '../game/rules'
import type { Board, SubmitReceipt } from '../net/api'

export type Screen = 'boot' | 'title' | 'hud' | 'pause' | 'results'
export type Target = { name: string; score: number } | null

export type UiActions = {
  play: () => void
  restart: () => void
  resume: () => void
  quit: () => void
  settings: (patch: Partial<SaveData>) => void
  rename: (name: string) => Promise<boolean>
  loadBoard: (period: 'today' | 'all') => Promise<Board>
  share: () => Promise<{ blobUrl: string; url: string; text: string; blob: Blob } | null>
  copyChallenge: () => Promise<boolean>
}

export type SubmitState = { kind: 'pending' } | { kind: 'ok'; receipt: SubmitReceipt } | { kind: 'offline' } | { kind: 'rejected' }

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const ICONS = {
  trophy: '<svg viewBox="0 0 24 24"><path d="M7 3h10v3h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 15.9V18h3v3H8v-3h3v-2.1A5 5 0 0 1 8.3 13H8a4 4 0 0 1-4-4V6h3V3Zm-1 5v1a2 2 0 0 0 1 1.7V8H6Zm11 0v2.7A2 2 0 0 0 18 9V8h-1Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M10 2h4l.6 2.6 2 .9 2.3-1.4 2.8 2.8-1.4 2.3.9 2 2.8.6v4l-2.6.6-.9 2 1.4 2.3-2.8 2.8-2.3-1.4-2 .9L14 22h-4l-.6-2.6-2-.9-2.3 1.4-2.8-2.8 1.4-2.3-.9-2L0 14v-4l2.6-.6.9-2L2.1 5.1 4.9 2.3l2.3 1.4 2-.9L10 2Zm2 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M18 2a3 3 0 1 1-2.8 4.1L8.9 9.3a3 3 0 0 1 0 1.4l6.3 3.2A3 3 0 1 1 14.6 16l-6.3-3.2a3 3 0 1 1 0-4.6l6.3-3.2A3 3 0 0 1 18 2Z"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10.6 13.4a4 4 0 0 1 0-5.7l3-3a4 4 0 1 1 5.7 5.7l-1.5 1.5-1.4-1.4 1.5-1.5a2 2 0 1 0-2.9-2.9l-3 3a2 2 0 0 0 0 2.9l-1.4 1.4Zm2.8-2.8a4 4 0 0 1 0 5.7l-3 3a4 4 0 1 1-5.7-5.7l1.5-1.5 1.4 1.4-1.5 1.5a2 2 0 1 0 2.9 2.9l3-3a2 2 0 0 0 0-2.9l1.4-1.4Z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M3 17.3V21h3.7L18.3 9.4l-3.7-3.7L3 17.3ZM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7Z"/></svg>',
}

/**
 * All HTML/CSS game UI. The canvas never draws text; this layer owns menus, the HUD, popups,
 * banners and modals. Text comes from the i18n dictionaries and re-renders on language change.
 */
export class Ui {
  screen: Screen = 'boot'
  modal: 'board' | 'settings' | 'share' | null = null
  private readonly root: HTMLElement
  private readonly $ = <T extends HTMLElement = HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!
  private hudCache = new Map<string, string>()
  private target: Target = null
  private best = 0
  private result: RunResult | null = null
  private boardPeriod: 'today' | 'all' = 'today'
  private feedCount = 0
  private resultShownAt = 0
  private countUp = 0

  constructor(private readonly i18n: I18n, private readonly save: SaveStore, private readonly audio: Audio, private readonly input: Input, private readonly actions: UiActions) {
    this.root = document.getElementById('ui')!
    this.root.innerHTML = this.template()
    this.bind()
    this.applyI18n()
    i18n.onChange(() => {
      this.applyI18n()
      this.refreshTitle()
      if (this.result) this.renderResultText()
    })
  }

  private t(key: string, vars?: Record<string, string | number>): string {
    return this.i18n.t(key, vars)
  }

  private template(): string {
    return `
<div class="screen boot" data-screen="boot">
  <div class="logo small"><span class="logo-main"></span></div>
  <div class="bar"><i></i></div>
  <p data-i18n="boot.loading"></p>
</div>

<div class="screen title" data-screen="title">
  <div class="title-top">
    <button class="icon-btn" data-act="board" aria-label="leaderboard">${ICONS.trophy}</button>
    <button class="icon-btn" data-act="settings" aria-label="settings">${ICONS.gear}</button>
  </div>
  <div class="title-main">
    <div class="logo"><span class="logo-main" data-i18n="title.name"></span><span class="logo-en">PAINT GRAB</span></div>
    <p class="tagline" data-i18n="title.sub"></p>
    <div class="challenge-card hidden" id="challenge-card">
      <div class="cc-flag">VS</div>
      <div><b id="cc-name"></b><span id="cc-score"></span></div>
    </div>
    <ol class="how">
      <li><i class="how-ico how-1"></i><span data-i18n="how.1"></span></li>
      <li><i class="how-ico how-2"></i><span data-i18n="how.2"></span></li>
      <li><i class="how-ico how-3"></i><span data-i18n="how.3"></span></li>
    </ol>
    <button class="btn btn-play" data-act="play"><span data-i18n="title.play"></span><small data-i18n="title.playHint"></small></button>
    <div class="title-meta">
      <span class="chip chip-daily" id="daily-chip"></span>
      <span class="chip" id="best-chip"></span>
      <label class="chip chip-nick">${ICONS.pencil}<input id="t-nick" maxlength="16" autocomplete="off" spellcheck="false" /></label>
    </div>
    <p class="controls" id="controls-hint"></p>
  </div>
</div>

<div class="hud" data-screen="hud">
  <div class="hud-left">
    <div class="card me-card">
      <div class="me-pct"><b id="h-pct">0.0%</b><small data-i18n="hud.land"></small></div>
      <div class="me-score"><b id="h-score">0</b><small data-i18n="hud.score"></small></div>
      <div class="me-place" id="h-place">#1</div>
    </div>
    <div class="combo" id="h-combo"><b id="h-combo-n"></b><i><u id="h-combo-bar"></u></i></div>
    <div class="target hidden" id="h-target"><span id="h-target-label"></span><i><u id="h-target-bar"></u></i></div>
    <div class="best-mini" id="h-best"></div>
  </div>
  <div class="hud-center">
    <div class="timer" id="h-timer">1:30</div>
    <div class="hint" id="h-hint"></div>
  </div>
  <div class="hud-right">
    <button class="icon-btn small" data-act="pause" aria-label="pause">${ICONS.pause}</button>
    <ul class="rivals" id="h-rivals"></ul>
    <ul class="feed" id="h-feed"></ul>
  </div>
  <div class="boost" id="h-boost"><i><u id="h-boost-bar"></u></i><span data-i18n="hud.boost"></span></div>
</div>

<div class="screen pause" data-screen="pause">
  <div class="panel">
    <h2 data-i18n="pause.title"></h2>
    <button class="btn" data-act="resume"><span data-i18n="pause.resume"></span></button>
    <button class="btn btn-alt" data-act="restart"><span data-i18n="pause.restart"></span></button>
    <button class="btn btn-alt" data-act="settings"><span data-i18n="title.settings"></span></button>
    <button class="btn btn-ghost" data-act="quit"><span data-i18n="pause.quit"></span></button>
  </div>
</div>

<div class="screen results" data-screen="results">
  <div class="panel results-panel">
    <h2 id="r-title"></h2>
    <p class="r-sub" id="r-sub"></p>
    <div class="r-score"><b id="r-score">0</b><span class="badge hidden" id="r-newbest" data-i18n="end.newBest"></span></div>
    <ul class="r-break" id="r-break"></ul>
    <div class="r-rank" id="r-rank"></div>
    <div class="r-target hidden" id="r-target"></div>
    <div class="r-nick">
      <label for="r-nick-input" data-i18n="end.nick"></label>
      <div class="r-nick-row"><input id="r-nick-input" maxlength="16" autocomplete="off" spellcheck="false" /><button class="btn btn-small" data-act="save-nick"><span data-i18n="end.save"></span></button></div>
      <small class="r-nick-msg" id="r-nick-msg"></small>
    </div>
    <button class="btn btn-play" data-act="restart"><span data-i18n="end.again"></span><small data-i18n="end.againHint"></small></button>
    <div class="r-actions">
      <button class="btn btn-alt btn-small" data-act="share">${ICONS.share}<span data-i18n="end.share"></span></button>
      <button class="btn btn-alt btn-small" data-act="copy">${ICONS.link}<span data-i18n="end.copy"></span></button>
      <button class="btn btn-alt btn-small" data-act="board">${ICONS.trophy}<span data-i18n="end.board"></span></button>
    </div>
  </div>
</div>

<div class="modal" data-modal="board">
  <div class="panel board-panel">
    <h2 data-i18n="board.title"></h2>
    <div class="tabs"><button data-period="today" data-i18n="board.today"></button><button data-period="all" data-i18n="board.all"></button></div>
    <div class="board-meta" id="b-meta"></div>
    <ol class="board-list" id="b-list"></ol>
    <button class="btn btn-alt" data-act="close"><span data-i18n="board.close"></span></button>
  </div>
</div>

<div class="modal" data-modal="settings">
  <div class="panel settings-panel">
    <h2 data-i18n="settings.title"></h2>
    <label class="row"><span data-i18n="settings.music"></span><input type="range" min="0" max="1" step="0.05" id="s-music" /></label>
    <label class="row"><span data-i18n="settings.sfx"></span><input type="range" min="0" max="1" step="0.05" id="s-sfx" /></label>
    <label class="row"><span data-i18n="settings.mute"></span><input type="checkbox" id="s-mute" /></label>
    <div class="row"><span data-i18n="settings.quality"></span><div class="seg" id="s-quality"><button data-q="low" data-i18n="settings.low"></button><button data-q="medium" data-i18n="settings.medium"></button><button data-q="high" data-i18n="settings.high"></button></div></div>
    <label class="row"><span data-i18n="settings.motion"></span><input type="checkbox" id="s-motion" /></label>
    <div class="row"><span data-i18n="settings.language"></span><div class="seg" id="s-lang"><button data-l="zh-CN">中文</button><button data-l="en">English</button></div></div>
    <button class="btn" data-act="close"><span data-i18n="settings.done"></span></button>
    <small class="credits" data-i18n="credits.fonts"></small>
  </div>
</div>

<div class="modal" data-modal="share">
  <div class="panel share-panel">
    <h2 data-i18n="share.title"></h2>
    <img id="sh-img" alt="share card" />
    <input id="sh-url" readonly />
    <div class="r-actions">
      <a class="btn btn-small" id="sh-download" download="paint-grab.png">${ICONS.share}<span data-i18n="share.download"></span></a>
      <button class="btn btn-alt btn-small" data-act="copy">${ICONS.link}<span data-i18n="share.copy"></span></button>
      <button class="btn btn-alt btn-small hidden" data-act="native" id="sh-native"><span data-i18n="share.native"></span></button>
    </div>
    <button class="btn btn-ghost" data-act="close"><span data-i18n="board.close"></span></button>
  </div>
</div>

<div class="fx-layer">
  <div class="vignette" id="vignette"></div>
  <div class="flash" id="flash"></div>
  <div class="banner" id="banner"></div>
  <div id="popups"></div>
</div>
<div class="toast" id="toast"></div>`
  }

  private bind(): void {
    this.root.addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
      if (!el) return
      this.audio.unlock()
      this.audio.play('ui')
      const act = el.dataset.act!
      switch (act) {
        case 'play': this.actions.play(); break
        case 'restart': this.actions.restart(); break
        case 'resume': this.actions.resume(); break
        case 'quit': this.actions.quit(); break
        case 'pause': window.dispatchEvent(new Event('game:pause')); break
        case 'board': this.openBoard(this.boardPeriod); break
        case 'settings': this.openSettings(); break
        case 'close': this.closeModal(); break
        case 'save-nick': void this.saveNick(); break
        case 'share': void this.openShare(); break
        case 'copy': void this.copyChallenge(); break
        case 'native': void this.nativeShare(); break
      }
    })
    this.root.querySelectorAll<HTMLButtonElement>('.tabs [data-period]').forEach(b => b.addEventListener('click', () => {
      this.audio.play('ui')
      this.openBoard(b.dataset.period as 'today' | 'all')
    }))
    const s = this.save
    this.$<HTMLInputElement>('#s-music').addEventListener('input', e => this.actions.settings({ musicVolume: Number((e.target as HTMLInputElement).value) }))
    this.$<HTMLInputElement>('#s-sfx').addEventListener('input', e => this.actions.settings({ sfxVolume: Number((e.target as HTMLInputElement).value) }))
    this.$<HTMLInputElement>('#s-mute').addEventListener('change', e => this.actions.settings({ muted: (e.target as HTMLInputElement).checked }))
    this.$<HTMLInputElement>('#s-motion').addEventListener('change', e => this.actions.settings({ reducedMotion: (e.target as HTMLInputElement).checked }))
    this.root.querySelectorAll<HTMLButtonElement>('#s-quality button').forEach(b => b.addEventListener('click', () => {
      this.actions.settings({ quality: b.dataset.q as Quality })
      this.refreshSettings()
    }))
    this.root.querySelectorAll<HTMLButtonElement>('#s-lang button').forEach(b => b.addEventListener('click', () => {
      this.actions.settings({ locale: b.dataset.l as Locale })
      this.refreshSettings()
    }))
    this.$<HTMLInputElement>('#r-nick-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void this.saveNick()
      }
      e.stopPropagation()
    })
    const tn = this.$<HTMLInputElement>('#t-nick')
    tn.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Enter') tn.blur()
    })
    tn.addEventListener('change', () => {
      if (cleanName(tn.value) !== this.save.data.playerName) void this.applyNick(tn.value).then(ok => ok && this.toast(this.t('end.saved')))
    })
    this.root.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => {
      if (e.target === m) this.closeModal()
    }))
    void s
  }

  applyI18n(): void {
    this.root.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => (el.textContent = this.t(el.dataset.i18n!)))
    // Title letters each wear a rival colour.
    this.root.querySelectorAll<HTMLElement>('.logo-main').forEach(el => {
      el.innerHTML = [...this.t('title.name')].map(ch => (ch === ' ' ? '<b>&nbsp;</b>' : `<b>${esc(ch)}</b>`)).join('')
    })
    this.hudCache.clear()
  }

  show(screen: Screen): void {
    this.screen = screen
    this.root.dataset.view = screen
    this.root.querySelectorAll<HTMLElement>('[data-screen]').forEach(el => el.classList.toggle('active', el.dataset.screen === screen))
    if (screen === 'title') this.refreshTitle()
    if (screen === 'hud') {
      this.hudCache.clear()
      this.$('#h-feed').innerHTML = ''
    }
  }

  setBootProgress(p: number): void {
    this.$<HTMLElement>('.boot .bar i').style.width = `${Math.round(p * 100)}%`
  }

  setTarget(target: Target, best: number): void {
    this.target = target
    this.best = best
    this.refreshTitle()
  }

  refreshTitle(): void {
    const d = this.save.data
    const day = new Date().toISOString().slice(0, 10)
    this.$('#daily-chip').textContent = this.t('title.daily', { day })
    this.$('#daily-chip').title = this.t('title.dailyHint')
    this.$('#best-chip').textContent = d.bestScore > 0 ? this.t('title.best', { score: d.bestScore }) : this.t('title.noBest')
    const nick = this.$<HTMLInputElement>('#t-nick')
    nick.placeholder = this.t('title.nick')
    if (document.activeElement !== nick) nick.value = d.playerName
    const card = this.$('#challenge-card')
    card.classList.toggle('hidden', !this.target)
    if (this.target) {
      this.$('#cc-name').textContent = this.t('title.challenge', { name: this.target.name || '???' })
      this.$('#cc-score').textContent = this.t('title.challengeScore', { score: this.target.score })
    }
    const touch = matchMedia('(pointer: coarse)').matches
    this.$('#controls-hint').textContent = touch ? this.t('controls.touch') : this.input.method === 'gamepad' ? this.t('controls.pad') : this.t('controls.desk')
  }

  refreshSettings(): void {
    const d = this.save.data
    this.$<HTMLInputElement>('#s-music').value = String(d.musicVolume)
    this.$<HTMLInputElement>('#s-sfx').value = String(d.sfxVolume)
    this.$<HTMLInputElement>('#s-mute').checked = d.muted
    this.$<HTMLInputElement>('#s-motion').checked = d.reducedMotion
    this.root.querySelectorAll<HTMLButtonElement>('#s-quality button').forEach(b => b.classList.toggle('on', b.dataset.q === d.quality))
    this.root.querySelectorAll<HTMLButtonElement>('#s-lang button').forEach(b => b.classList.toggle('on', b.dataset.l === this.i18n.locale))
  }

  // ---------- HUD ----------
  private set(id: string, value: string, prop: 'text' | 'html' = 'text'): void {
    if (this.hudCache.get(id) === value) return
    this.hudCache.set(id, value)
    const el = this.$(id)
    if (prop === 'html') el.innerHTML = value
    else el.textContent = value
  }

  updateHud(h: HudState, hint: string): void {
    this.set('#h-timer', formatClock(h.timeLeft))
    this.$('#h-timer').classList.toggle('hot', h.timeLeft <= 10)
    this.$('#h-timer').classList.toggle('warm', h.timeLeft <= 30 && h.timeLeft > 10)
    this.set('#h-pct', formatPct(h.bp))
    this.set('#h-score', String(h.score))
    this.set('#h-place', this.t('hud.place', { n: h.place }))
    const combo = this.$('#h-combo')
    combo.classList.toggle('on', h.combo >= 1 && h.comboFrac > 0)
    this.set('#h-combo-n', h.combo >= 1 ? `x${h.combo}` : '')
    ;(this.$('#h-combo-bar') as HTMLElement).style.width = `${Math.round(h.comboFrac * 100)}%`
    ;(this.$('#h-boost-bar') as HTMLElement).style.width = `${Math.round(h.boostReady * 100)}%`
    this.$('#h-boost').classList.toggle('ready', h.boostReady >= 1)
    const tgt = this.$('#h-target')
    tgt.classList.toggle('hidden', !this.target)
    if (this.target) {
      const done = h.score > this.target.score
      this.set('#h-target-label', done ? this.t('hud.targetDone', { name: this.target.name }) : this.t('hud.target', { name: this.target.name, score: this.target.score }))
      ;(this.$('#h-target-bar') as HTMLElement).style.width = `${Math.min(100, Math.round((h.score / Math.max(1, this.target.score)) * 100))}%`
      tgt.classList.toggle('done', done)
    }
    this.set('#h-best', this.best > 0 ? this.t('hud.best', { score: this.best }) : '')
    this.$('#h-best').classList.toggle('beaten', this.best > 0 && h.score > this.best)
    this.set('#h-hint', hint)
    this.$('#h-hint').classList.toggle('show', !!hint)
    this.$('#h-hint').classList.toggle('danger', h.danger > 0.5)
    const rivals = h.rivals
      .map(r => `<li class="${r.alive ? '' : 'dead'} ${r.hunting ? 'hunting' : ''}"><i style="background:${r.color}"></i><span class="nm">${esc(r.name)}</span><em class="p-${r.personality}">${esc(this.t('personality.' + r.personality))}</em><b>${r.alive ? formatPct(r.bp) : this.t('hud.ko') + ' ' + this.t('hud.respawn', { s: Math.ceil(Math.max(0, r.respawnIn)) })}</b></li>`)
      .join('')
    this.set('#h-rivals', rivals, 'html')
    ;(this.$('#vignette') as HTMLElement).style.opacity = String(Math.min(1, h.danger * 1.1))
  }

  popup(text: string, at: { x: number; y: number } | null, kind: PopupKind): void {
    const el = document.createElement('div')
    el.className = `popup ${kind}`
    el.textContent = text
    const x = at ? at.x : innerWidth / 2
    const y = at ? at.y : innerHeight * 0.4
    el.style.left = `${Math.max(60, Math.min(innerWidth - 60, x))}px`
    el.style.top = `${Math.max(60, Math.min(innerHeight - 60, y))}px`
    this.$('#popups').appendChild(el)
    window.setTimeout(() => el.remove(), 1300)
  }

  banner(key: string, kind: string): void {
    const el = this.$('#banner')
    el.className = `banner ${kind}`
    el.textContent = this.t('banner.' + key)
    void el.offsetWidth
    el.classList.add('show')
    window.clearTimeout((el as unknown as { _t: number })._t)
    ;(el as unknown as { _t: number })._t = window.setTimeout(() => el.classList.remove('show'), kind === 'go' ? 900 : 1700)
  }

  feed(killer: { name: string; color: string } | null, victim: { name: string; color: string }, reason: 'cut' | 'wiped'): void {
    const list = this.$('#h-feed')
    const li = document.createElement('li')
    const k = killer ? `<b style="color:${killer.color}">${esc(killer.name)}</b>` : '?'
    const v = `<b style="color:${victim.color}">${esc(victim.name)}</b>`
    li.innerHTML = this.t(reason === 'cut' ? 'feed.cut' : 'feed.wiped', { killer: '§K', victim: '§V' }).replace('§K', k).replace('§V', v)
    list.prepend(li)
    this.feedCount += 1
    while (list.children.length > 4) list.lastElementChild?.remove()
    window.setTimeout(() => li.classList.add('fade'), 3500)
    window.setTimeout(() => li.remove(), 4200)
  }

  flash(kind: 'death' | 'kill' | 'capture'): void {
    const el = this.$('#flash')
    el.className = `flash ${kind}`
    void el.offsetWidth
    el.classList.add('show')
  }

  toast(msg: string): void {
    const el = this.$('#toast')
    el.textContent = msg
    el.classList.add('show')
    window.clearTimeout((el as unknown as { _t: number })._t)
    ;(el as unknown as { _t: number })._t = window.setTimeout(() => el.classList.remove('show'), 2200)
  }

  // ---------- Results ----------
  showResults(r: RunResult, newBest: boolean, previousBest: number): void {
    this.result = r
    this.show('results')
    this.resultShownAt = performance.now()
    this.$('#r-newbest').classList.toggle('hidden', !newBest)
    this.$('.results-panel').classList.toggle('win', r.reason === 'time')
    this.renderResultText(previousBest)
    this.setSubmit({ kind: 'pending' })
    const input = this.$<HTMLInputElement>('#r-nick-input')
    input.value = this.save.data.playerName
    this.$('#r-nick-msg').textContent = ''
    // Score count-up.
    const el = this.$('#r-score')
    const start = performance.now()
    const dur = 900
    cancelAnimationFrame(this.countUp)
    const tick = () => {
      const k = Math.min(1, (performance.now() - start) / dur)
      el.textContent = String(Math.round(r.score * (1 - Math.pow(1 - k, 3))))
      if (k < 1) this.countUp = requestAnimationFrame(tick)
    }
    tick()
  }

  private renderResultText(previousBest = this.best): void {
    const r = this.result
    if (!r) return
    const killer = r.killer ? r.killer[this.i18n.locale === 'zh-CN' ? 'zh' : 'en'] : '?'
    this.$('#r-title').textContent = this.t(r.reason === 'time' ? 'end.time' : r.reason === 'cut' ? 'end.cut' : 'end.wiped')
    this.$('#r-sub').textContent = r.reason === 'time' ? this.t('end.survived') : this.t(r.reason === 'cut' ? 'end.cutBy' : 'end.wipedBy', { name: killer }) + ' · ' + this.t('end.place', { n: r.place, total: r.entrants })
    const rows: Array<[string, number]> = [[this.t('end.land', { pct: formatPct(r.territoryBp) }), r.territoryBp]]
    if (r.kills) rows.push([this.t('end.kills', { n: r.kills }), r.kills * 300])
    if (r.comboBonus) rows.push([this.t('end.combo'), r.comboBonus])
    if (r.survived) rows.push([this.t('end.survive'), 500])
    this.$('#r-break').innerHTML = rows.map(([k, v]) => `<li><span>${esc(k)}</span><b>+${v}</b></li>`).join('') + (previousBest > 0 ? `<li class="muted"><span>${esc(this.t('end.bestWas', { score: previousBest }))}</span></li>` : '')
    const tgt = this.$('#r-target')
    tgt.classList.toggle('hidden', !this.target)
    if (this.target) {
      const win = r.score > this.target.score
      tgt.classList.toggle('win', win)
      tgt.textContent = win ? this.t('end.targetWin', { name: this.target.name, score: this.target.score }) : this.t('end.targetLose', { name: this.target.name, score: this.target.score, gap: this.target.score - r.score + 1 })
    }
  }

  setSubmit(s: SubmitState): void {
    const el = this.$('#r-rank')
    el.className = `r-rank ${s.kind}`
    if (s.kind === 'pending') el.innerHTML = `<span class="spin"></span>${esc(this.t('end.submitting'))}`
    else if (s.kind === 'offline') el.textContent = this.t('end.offline')
    else if (s.kind === 'rejected') el.textContent = this.t('end.rejected')
    else {
      const r = s.receipt
      el.innerHTML = `<div class="ranks"><span>${esc(this.t('end.rankToday', { rank: r.today.rank }))}</span><span>${esc(this.t('end.rankAll', { rank: r.all.rank }))}</span></div><div class="beat">${esc(this.t('end.beat', { pct: r.all.beatPercent }))}</div>`
    }
  }

  /** Space/Enter on results restarts, but not in the first moment (so a held key doesn't skip it). */
  resultsReady(): boolean {
    return this.screen === 'results' && performance.now() - this.resultShownAt > 450 && document.activeElement?.tagName !== 'INPUT'
  }

  private async saveNick(): Promise<void> {
    const input = this.$<HTMLInputElement>('#r-nick-input')
    const ok = await this.applyNick(input.value)
    this.$('#r-nick-msg').textContent = ok ? this.t('end.saved') : this.t('nick.invalid')
    this.$('#r-nick-msg').classList.toggle('bad', !ok)
    if (ok) input.blur()
  }

  private async applyNick(raw: string): Promise<boolean> {
    const name = cleanName(raw)
    if (!name) {
      this.toast(this.t('nick.invalid'))
      return false
    }
    const ok = await this.actions.rename(name)
    this.refreshTitle()
    return ok
  }

  // ---------- Modals ----------
  private openModal(name: 'board' | 'settings' | 'share'): void {
    this.modal = name
    this.root.querySelectorAll<HTMLElement>('[data-modal]').forEach(el => el.classList.toggle('active', el.dataset.modal === name))
    this.root.classList.add('modal-open')
  }

  closeModal(): void {
    this.modal = null
    this.root.querySelectorAll<HTMLElement>('[data-modal]').forEach(el => el.classList.remove('active'))
    this.root.classList.remove('modal-open')
  }

  openSettings(): void {
    this.refreshSettings()
    this.openModal('settings')
  }

  async openBoard(period: 'today' | 'all'): Promise<void> {
    this.boardPeriod = period
    this.openModal('board')
    this.root.querySelectorAll<HTMLButtonElement>('.tabs [data-period]').forEach(b => b.classList.toggle('on', b.dataset.period === period))
    const list = this.$('#b-list')
    list.innerHTML = `<li class="empty">${esc(this.t('board.loading'))}</li>`
    this.$('#b-meta').textContent = ''
    try {
      const b = await this.actions.loadBoard(period)
      if (this.boardPeriod !== period) return
      this.$('#b-meta').textContent = [this.t('board.players', { n: b.total }), b.myRank ? this.t('board.me', { rank: b.myRank.rank, score: b.myRank.score }) : ''].filter(Boolean).join(' · ')
      list.innerHTML = b.entries.length
        ? b.entries.map(e => `<li class="${e.isMe ? 'me' : ''} r${e.rank <= 3 ? e.rank : ''}"><span class="rk">${e.rank}</span><span class="nm">${esc(e.displayName)}</span><span class="pc">${e.territoryBp == null ? '' : formatPct(e.territoryBp)}</span><b>${e.score}</b></li>`).join('')
        : `<li class="empty">${esc(this.t('board.empty'))}</li>`
    } catch {
      list.innerHTML = `<li class="empty">${esc(this.t('board.error'))}</li>`
    }
  }

  private shareData: { url: string; text: string; blob: Blob } | null = null

  async openShare(): Promise<void> {
    const res = await this.actions.share()
    if (!res) return
    this.shareData = res
    this.$<HTMLImageElement>('#sh-img').src = res.blobUrl
    this.$<HTMLAnchorElement>('#sh-download').href = res.blobUrl
    this.$<HTMLInputElement>('#sh-url').value = res.url
    const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([res.blob], 'paint-grab.png', { type: 'image/png' })] })
    this.$('#sh-native').classList.toggle('hidden', !canShare)
    this.openModal('share')
  }

  private async nativeShare(): Promise<void> {
    if (!this.shareData) return
    try {
      await navigator.share({ files: [new File([this.shareData.blob], 'paint-grab.png', { type: 'image/png' })], text: this.shareData.text })
    } catch {
      // Cancelled.
    }
  }

  private async copyChallenge(): Promise<void> {
    const ok = await this.actions.copyChallenge()
    this.toast(ok ? this.t('share.copied') : this.t('share.copyFail'))
  }
}
