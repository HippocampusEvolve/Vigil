import type { Surface } from '../support'

export type Step = { at: number; x: number; z: number; surface: Surface; running: boolean }
export type TapeCue = { at: number; kind: 'step' | 'splice' | 'bell' | 'hiss' | 'latch' | 'door' | 'stop' | 'breath' | 'fall'; step?: Step }

/** The player's footsteps are kept in session memory, including real pauses. */
export class StepTrack {
  private steps: Step[] = []
  private origin: number | null = null
  record(at: number, x: number, z: number, surface: Surface, running: boolean): void {
    if (this.origin === null) this.origin = at
    if (this.steps.length < 1024) this.steps.push({ at: at - this.origin, x, z, surface, running })
  }
  snapshot(): readonly Step[] { return this.steps.slice() }
}

/** Silence above three seconds is cut to 1.5 seconds, as on a sound-triggered tape. */
export function scheduleTape(recorded: readonly Step[], fallback: readonly Step[] = []): TapeCue[] {
  const steps = recorded.length ? recorded : fallback
  const out: TapeCue[] = []
  for (let i = 0; i < 18; i++) {
    out.push({ at: 2 + i * 2.25, kind: 'step', step: { at: 0, x: i < 9 ? -10 : 2, z: i < 9 ? -4 : 0.7, surface: 'mud', running: false } })
  }
  out.push({ at: 45, kind: 'breath' }, { at: 48, kind: 'fall' }, { at: 50, kind: 'splice' })
  let time = 50.5
  let last = steps[0]?.at ?? 0
  for (const step of steps) {
    time += Math.min(Math.max(0, step.at - last), 3) > 2.99 ? 1.5 : Math.max(0, step.at - last)
    out.push({ at: time, kind: 'step', step })
    last = step.at
  }
  time += 0.7
  out.push({ at: time, kind: 'bell' }, { at: time + 0.3, kind: 'hiss' },
    { at: time + 4.4, kind: 'latch' }, { at: time + 5.2, kind: 'door' },
    { at: time + 8, kind: 'stop' })
  return out
}
