/** Smooth bounded envelopes used by rain, clouds and fog. */
export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
export const smooth = (v: number): number => { const t = clamp01(v); return t * t * (3 - 2 * t) }
export function clearState(seconds: number): { rain: number; sky: number; fog: number } {
  return { rain: 1 - smooth(seconds / 30), sky: smooth(seconds / 40), fog: 0.03 + (0.004 - 0.03) * smooth(seconds / 40) }
}
