import { describe, expect, it } from 'vitest'
import { SAVE_KEY, SaveStore, cleanName, defaultSave, parseSave } from '../src/engine/save'

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

describe('save', () => {
  it('falls back to defaults on missing or corrupt data', () => {
    expect(parseSave(null)).toEqual(defaultSave())
    expect(parseSave('{not json')).toEqual(defaultSave())
  })
  it('persists updates and personal bests', () => {
    const mem = memory()
    const s = new SaveStore(mem)
    s.update({ playerName: 'Tester' })
    const first = s.recordRun(1200, 800, '2026-09-26')
    expect(first.allTime).toBe(true)
    const worse = s.recordRun(900, 500, '2026-09-26')
    expect(worse.allTime).toBe(false)
    expect(worse.previousBest).toBe(1200)
    const again = new SaveStore(mem)
    expect(again.data.playerName).toBe('Tester')
    expect(mem.m.has(SAVE_KEY)).toBe(true)
  })
  it('cleans nicknames', () => {
    expect(cleanName('  a   b  ')).toBe('a b')
    expect(cleanName('<script>')).not.toContain('<')
    expect([...cleanName('x'.repeat(40))].length).toBeLessThanOrEqual(16)
  })
})
