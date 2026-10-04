import qrcode from 'qrcode-generator'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Challenge link: the run id is verified server-side; `s`/`n` are only an offline preview. */
export function challengeUrl(runId: string | null, score: number, name: string): string {
  const url = new URL(location.href)
  url.search = ''
  url.hash = ''
  if (runId) url.searchParams.set('c', runId)
  url.searchParams.set('s', String(Math.max(0, Math.floor(score))))
  if (name) url.searchParams.set('n', name.slice(0, 16))
  return url.toString()
}

export type ChallengeParams = { runId: string | null; score: number; name: string }

/** Parse and sanity-check challenge params from the current URL. */
export function readChallenge(search = location.search, maxScore = 20000): ChallengeParams | null {
  const q = new URLSearchParams(search)
  const c = q.get('c')
  const s = Number(q.get('s'))
  const runId = c && UUID.test(c) ? c.toLowerCase() : null
  const score = Number.isInteger(s) && s > 0 && s <= maxScore ? s : 0
  const name = (q.get('n') ?? '').replace(/[\u0000-\u001f<>&"'`\\]/g, '').trim().slice(0, 16)
  if (!runId && !score) return null
  return { runId, score, name }
}

export type CardData = {
  title: string
  subtitle: string
  score: number
  scoreLabel: string
  rankLine: string
  land: string
  kills: string
  cta: string
  day: string
  url: string
  name: string
  owner: Int8Array
  size: number
  colors: string[]
  playerColor: string
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

/** Set the largest font (weight/size/family) at or below `size` whose text fits `maxW`. */
function fitFont(g: CanvasRenderingContext2D, text: string, weight: number, size: number, family: string, maxW: number): void {
  let px = size
  g.font = `${weight} ${px}px ${family}`
  while (px > 12 && g.measureText(text).width > maxW) {
    px -= 2
    g.font = `${weight} ${px}px ${family}`
  }
}
function outlined(g: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, stroke: string, width: number, shadow = 0): void {
  g.lineJoin = 'round'
  if (shadow) {
    g.fillStyle = stroke
    g.lineWidth = width
    g.strokeStyle = stroke
    g.strokeText(text, x + shadow, y + shadow)
    g.fillText(text, x + shadow, y + shadow)
  }
  g.lineWidth = width
  g.strokeStyle = stroke
  g.strokeText(text, x, y)
  g.fillStyle = fill
  g.fillText(text, x, y)
}

/** Draw the 1080×1350 share card (portrait, social-feed friendly). */
export async function renderCard(d: CardData): Promise<HTMLCanvasElement> {
  await document.fonts?.ready
  const W = 1080
  const H = 1350
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const ink = '#1d1640'
  const display = getComputedStyle(document.documentElement).getPropertyValue('--display') || 'sans-serif'

  // Background: sky gradient + low-poly shards.
  const bg = g.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, '#6fc3ff')
  bg.addColorStop(0.55, '#b9a6ff')
  bg.addColorStop(1, '#ff9ec4')
  g.fillStyle = bg
  g.fillRect(0, 0, W, H)
  let seed = d.score * 9301 + 49297
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
  for (let i = 0; i < 40; i += 1) {
    g.fillStyle = `rgba(255,255,255,${0.04 + rnd() * 0.08})`
    g.beginPath()
    const x = rnd() * W
    const y = rnd() * H
    g.moveTo(x, y)
    g.lineTo(x + (rnd() - 0.5) * 300, y + (rnd() - 0.5) * 300)
    g.lineTo(x + (rnd() - 0.5) * 300, y + (rnd() - 0.5) * 300)
    g.fill()
  }

  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  g.font = `900 112px ${display}`
  outlined(g, d.title, W / 2, 170, '#ffffff', ink, 22, 10)
  g.font = `800 40px ${display}`
  outlined(g, d.subtitle, W / 2, 232, '#fff27a', ink, 12)

  // Panel with final map.
  const px = 90
  const py = 280
  const pw = W - 180
  const ph = 700
  g.fillStyle = ink
  roundRect(g, px + 12, py + 14, pw, ph, 42)
  g.fill()
  g.fillStyle = '#fff7e8'
  roundRect(g, px, py, pw, ph, 42)
  g.fill()
  g.lineWidth = 8
  g.strokeStyle = ink
  g.stroke()

  const mapSize = 330
  const mx = px + 48
  const my = py + 52
  const cell = mapSize / d.size
  g.fillStyle = '#e4dff2'
  roundRect(g, mx - 10, my - 10, mapSize + 20, mapSize + 20, 22)
  g.fill()
  for (let i = 0; i < d.owner.length; i += 1) {
    const o = d.owner[i]
    const x = i % d.size
    const z = Math.floor(i / d.size)
    g.fillStyle = o >= 0 ? d.colors[o] : (x + z) % 2 ? '#efeaf9' : '#e7e1f5'
    g.fillRect(mx + x * cell, my + z * cell, Math.ceil(cell), Math.ceil(cell))
  }
  g.lineWidth = 6
  g.strokeStyle = ink
  roundRect(g, mx - 10, my - 10, mapSize + 20, mapSize + 20, 22)
  g.stroke()

  // Score block.
  const sx = mx + mapSize + 40
  g.textAlign = 'left'
  const maxW = px + pw - 36 - sx
  fitFont(g, d.name, 800, 38, display, maxW)
  g.fillStyle = ink
  g.fillText(d.name, sx, my + 40)
  fitFont(g, String(d.score), 900, 150, display, maxW - 20)
  outlined(g, String(d.score), sx - 4, my + 190, d.playerColor, ink, 16, 8)
  g.font = `900 40px ${display}`
  g.fillStyle = ink
  g.fillText(d.scoreLabel, sx + 4, my + 245)
  const stats = `${d.land}  ·  ${d.kills}`
  fitFont(g, stats, 800, 34, display, maxW)
  g.fillStyle = '#5b4fa0'
  g.fillText(stats, sx, my + 305)

  // Rank ribbon.
  g.fillStyle = '#ffd23f'
  roundRect(g, px + 40, py + 440, pw - 80, 96, 26)
  g.fill()
  g.lineWidth = 6
  g.strokeStyle = ink
  g.stroke()
  g.textAlign = 'center'
  fitFont(g, d.rankLine, 900, 46, display, pw - 140)
  g.fillStyle = ink
  g.fillText(d.rankLine, W / 2, py + 504)
  g.font = `700 30px ${display}`
  g.fillStyle = '#6b5fb0'
  g.fillText(d.day, W / 2, py + 600)

  // QR + CTA.
  const qr = qrcode(0, 'M')
  qr.addData(d.url)
  qr.make()
  const count = qr.getModuleCount()
  const qs = 250
  const qx = px + 30
  const qy = py + ph + 50
  g.fillStyle = ink
  roundRect(g, qx + 10, qy + 12, qs + 40, qs + 40, 26)
  g.fill()
  g.fillStyle = '#ffffff'
  roundRect(g, qx, qy, qs + 40, qs + 40, 26)
  g.fill()
  const m = qs / count
  g.fillStyle = ink
  for (let r = 0; r < count; r += 1) for (let col = 0; col < count; col += 1) if (qr.isDark(r, col)) g.fillRect(qx + 20 + col * m, qy + 20 + r * m, Math.ceil(m), Math.ceil(m))
  g.textAlign = 'left'
  const tx = qx + qs + 80
  const textW = W - tx - 50
  fitFont(g, d.cta, 900, 60, display, textW)
  outlined(g, d.cta, tx, qy + 120, '#ffffff', ink, 14, 6)
  g.fillStyle = ink
  const shortUrl = d.url.replace(/^https?:\/\//, '')
  const cut = shortUrl.indexOf('?')
  const host = cut > 0 ? shortUrl.slice(0, cut) : shortUrl
  fitFont(g, host, 800, 30, display, textW)
  g.fillText(host, tx + 2, qy + 185)
  if (cut > 0) {
    let rest = shortUrl.slice(cut)
    g.font = `600 22px ${display}`
    while (rest.length > 8 && g.measureText(rest).width > textW) rest = rest.slice(0, -2)
    if (rest.length < shortUrl.length - cut) rest += '…'
    g.fillStyle = '#5b4fa0'
    g.fillText(rest, tx + 2, qy + 225)
  }
  return c
}

export function canvasBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'))
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for iframes without clipboard permission.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}
