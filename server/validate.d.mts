export declare const RULES: {
  readonly boardId: string
  readonly rulesVersion: string
  readonly gridCells: number
  readonly startCells: number
  readonly roundMs: number
  readonly killBonus: number
  readonly surviveBonus: number
  readonly comboStep: number
  readonly comboCap: number
  readonly maxKills: number
  readonly maxSpeed: number
}
export declare const MAX_COMBO_BONUS_PER_CAPTURE: number
export declare const MAX_SCORE: number
export declare function composeScore(p: { territoryBp: number; kills: number; comboBonus: number; survived: boolean }): number
export declare function maxTerritoryBp(durationMs: number): number
export declare function validateSubmission(data: Record<string, unknown>, elapsedMs: number): true
export declare function cleanDisplayName(value: unknown): string | null
export declare function utcDay(date?: Date): string
