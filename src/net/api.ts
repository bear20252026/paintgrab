import type { Guest, SaveStore } from '../engine/save'
import type { RunSubmission } from '../game/rules'

export const BOARD_ID = 'paint-v1'
const PROTOCOL = 1
const RULES = 'v1'

export type Standing = { rank: number; players: number; beatPercent: number }
export type SubmitReceipt = { runId: string; score: number; accepted: boolean; personalBest: boolean; dailyBest: boolean; all: Standing; today: Standing; day: string }
export type BoardEntry = { displayName: string; score: number; territoryBp: number | null; kills: number | null; rank: number; isMe: boolean }
export type Board = { period: 'today' | 'all'; day: string; total: number; myRank: { rank: number; score: number } | null; entries: BoardEntry[] }
export type Challenge = { runId: string; displayName: string; score: number; territoryBp: number | null; kills: number | null; day: string }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

/** Resolve API paths relative to the page so previews under a sub-path work too. */
function apiUrl(path: string): string {
  return new URL(`api/leaderboards/v1/${path}`, document.baseURI).toString()
}

/**
 * Thin client for the game's leaderboard API. Guests are anonymous: a random token stored in the
 * local save identifies the player; the nickname is just a display name.
 */
export class LeaderboardClient {
  private guestPromise: Promise<Guest> | null = null

  constructor(private readonly save: SaveStore) {}

  private async request<T>(method: string, path: string, body?: unknown, auth = false, timeoutMs = 8000): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (auth) {
      const g = await this.guest()
      headers.Authorization = `Bearer ${g.token}`
    }
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(apiUrl(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, credentials: 'omit' })
      const text = await res.text()
      let data: Record<string, unknown> = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        throw new ApiError(res.status, 'bad_response')
      }
      if (!res.ok) throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'http_' + res.status)
      return data as T
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, 'network')
    } finally {
      clearTimeout(timer)
    }
  }

  defaultName(): string {
    const zh = document.documentElement.lang === 'zh-CN'
    const n = Math.floor(1000 + Math.random() * 9000)
    return zh ? `圈地侠${n}` : `Grabber${n}`
  }

  /** Existing guest from the save, or a new one registered under the current nickname. */
  guest(): Promise<Guest> {
    const saved = this.save.data.guest
    if (saved) return Promise.resolve(saved)
    this.guestPromise ??= (async () => {
      const name = this.save.data.playerName || this.defaultName()
      const r = await this.request<{ playerId: string; token: string; displayName: string }>('POST', 'guests', { displayName: name })
      const g: Guest = { id: r.playerId, token: r.token, name: r.displayName }
      this.save.update({ guest: g, playerName: this.save.data.playerName || r.displayName })
      return g
    })().finally(() => {
      this.guestPromise = null
    })
    return this.guestPromise
  }

  private async withGuest<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      // Expired or revoked guest token: register again once and retry.
      if (err instanceof ApiError && (err.status === 401 || err.code === 'invalid_token' || err.code === 'unauthorized')) {
        this.save.update({ guest: null })
        return fn()
      }
      throw err
    }
  }

  async startRun(): Promise<{ runId: string; day: string }> {
    return this.withGuest(() => this.request('POST', `boards/${BOARD_ID}/runs`, { protocolVersion: PROTOCOL, rulesVersion: RULES }, true))
  }

  async submit(runId: string, run: RunSubmission): Promise<SubmitReceipt> {
    const body = { score: run.score, durationMs: run.durationMs, territoryBp: run.territoryBp, kills: run.kills, comboBonus: run.comboBonus, captures: run.captures, survived: run.survived }
    // Retry once on network failure; the server replays an identical submission idempotently.
    try {
      return await this.request('PUT', `runs/${runId}`, body, true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) return this.request('PUT', `runs/${runId}`, body, true)
      throw err
    }
  }

  async rename(name: string): Promise<string> {
    const r = await this.withGuest(() => this.request<{ displayName: string }>('PATCH', 'guests/me', { displayName: name }, true))
    const g = this.save.data.guest
    if (g) this.save.update({ guest: { ...g, name: r.displayName } })
    return r.displayName
  }

  async board(period: 'today' | 'all', limit = 50): Promise<Board> {
    const auth = !!this.save.data.guest
    return this.request('GET', `boards/${BOARD_ID}?period=${period}&limit=${limit}`, undefined, auth)
  }

  async challenge(runId: string): Promise<Challenge> {
    return this.request('GET', `challenges/${encodeURIComponent(runId)}`)
  }
}
