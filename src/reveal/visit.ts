import type { StoragePort } from '../scenario/journal'

export type VisitState = { visits: number; ending: 'a' | 'b' | null; endedAt: number; arrivals: number[]; position: [number, number, number] | null; yaw: number; pitch: number; weatherSeconds: number; actions: Record<string, number | boolean> }
const fresh = (): VisitState => ({ visits: 0, ending: null, endedAt: 0, arrivals: [], position: null, yaw: 0, pitch: 0, weatherSeconds: 0, actions: {} })

export function dayNumber(releaseDate: string | null, baseDay: number, now = Date.now()): number {
  if (!releaseDate) return baseDay
  const start = Date.parse(`${releaseDate}T00:00:00Z`)
  return Number.isFinite(start) ? baseDay + Math.max(0, Math.floor((now - start) / 86400000)) : baseDay
}

export function loadVisit(storage: StoragePort | null, key = 'vigil:visit:1'): { state: VisitState; save(state: VisitState): void } {
  let state = fresh()
  try {
    const raw = storage?.getItem(key)
    if (raw) {
      const value = JSON.parse(raw) as Partial<VisitState>
      if (Number.isInteger(value.visits) && Number.isFinite(value.endedAt))
        state = { ...state, ...value, arrivals: Array.isArray(value.arrivals) ? value.arrivals.filter(Number.isFinite) : [], position: Array.isArray(value.position) && value.position.length === 3 ? value.position as [number, number, number] : null, weatherSeconds: Number.isFinite(value.weatherSeconds) ? Number(value.weatherSeconds) : 0, actions: value.actions && typeof value.actions === 'object' ? value.actions : {} }
    }
  } catch { /* denied or damaged storage starts a new visit */ }
  return {
    get state() { return state },
    save(next) { state = next; try { storage?.setItem(key, JSON.stringify(next)) } catch { /* continue in memory */ } },
  }
}

export function afterEnding(state: VisitState, ending: 'a' | 'b', at = Date.now()): VisitState {
  return { ...state, visits: state.visits + 1, ending, endedAt: at, arrivals: ending === 'a' ? [...state.arrivals, at] : state.arrivals, position: null, weatherSeconds: 0, actions: {} }
}

export function returnMode(state: VisitState): 'new' | 'resume' | 'again' | 'epilogue' {
  if (state.ending === 'b') return 'epilogue'
  if (state.position) return 'resume'
  if (state.ending === 'a') return 'again'
  return 'new'
}
