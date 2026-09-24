/** Neutral Morse timing. Text and timing come from the optional data layer. */
const LETTERS: Record<string, string> = {
  А: '.-', Б: '-...', В: '.--', Г: '--.', Д: '-..', Е: '.', Ж: '...-', З: '--..',
  И: '..', Й: '.---', К: '-.-', Л: '.-..', М: '--', Н: '-.', О: '---', П: '.--.',
  Р: '.-.', С: '...', Т: '-', У: '..-', Ф: '..-.', Х: '....', Ц: '-.-.', Ч: '---.',
  Ш: '----', Щ: '--.-', Ъ: '--.--', Ы: '-.--', Ь: '-..-', Э: '..-..', Ю: '..--',
  Я: '.-.-', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
}

export type Pulse = { on: boolean; duration: number }

export function encode(word: string, unit: number): Pulse[] {
  if (!(unit > 0)) throw Error('Morse unit must be positive')
  const out: Pulse[] = []
  const words = word.toUpperCase().trim().split(/\s+/)
  for (let w = 0; w < words.length; w++) {
    if (w) out.push({ on: false, duration: 7 * unit })
    const chars = [...words[w]]
    for (let c = 0; c < chars.length; c++) {
      const code = LETTERS[chars[c]]
      if (!code) throw Error('Unsupported Morse character')
      if (c) out.push({ on: false, duration: 3 * unit })
      for (let i = 0; i < code.length; i++) {
        if (i) out.push({ on: false, duration: unit })
        out.push({ on: true, duration: (code[i] === '-' ? 3 : 1) * unit })
      }
    }
  }
  return out
}

export function decode(pulses: readonly Pulse[], unit: number): string {
  const reverse = new Map(Object.entries(LETTERS).map(([letter, code]) => [code, letter]))
  let result = ''
  let code = ''
  const letter = () => { if (code) { result += reverse.get(code) ?? '?'; code = '' } }
  for (const p of pulses) {
    const n = Math.round(p.duration / unit)
    if (p.on) code += n >= 2 ? '-' : '.'
    else if (n >= 6) { letter(); result += ' ' }
    else if (n >= 2) letter()
  }
  letter()
  return result
}

export class BeaconClock {
  private mode: 'off' | 'call' | 'wait' | 'answer' | 'steady' = 'off'
  private elapsed = 0
  private watched = true
  private pulses: Pulse[] = []
  private readonly gap: number
  constructor(private readonly call: Pulse[], private readonly answer: Pulse[]) {
    const dots = [...call, ...answer].filter((p) => p.on).map((p) => p.duration)
    this.gap = 7 * Math.min(...dots)
  }
  setCall(): void { this.mode = 'call'; this.elapsed = 0; this.pulses = this.call }
  reply(): void { this.mode = 'wait'; this.elapsed = 0; this.watched = true }
  steady(): void { this.mode = 'steady'; this.elapsed = 0 }
  update(dt: number, observed: boolean): { light: number; completed: boolean } {
    if (this.mode === 'off') return { light: 0, completed: false }
    if (this.mode === 'steady') return { light: 1, completed: false }
    this.elapsed += Math.max(0, dt)
    if (this.mode === 'wait') {
      if (this.elapsed < 3) return { light: 0, completed: false }
      this.elapsed -= 3; this.mode = 'answer'; this.pulses = this.answer; this.watched = observed
    }
    const duration = this.pulses.reduce((n, p) => n + p.duration, 0)
    if (!duration || !Number.isFinite(this.gap)) return { light: 0, completed: false }
    if (this.mode === 'answer') this.watched &&= observed
    if (this.mode === 'answer' && this.elapsed >= duration && this.watched) {
      this.steady(); return { light: 1, completed: true }
    }
    if (this.elapsed >= duration + this.gap) {
      this.elapsed %= duration + this.gap
      this.watched = observed
    }
    if (this.elapsed >= duration) return { light: 0, completed: false }
    let at = this.elapsed
    for (const p of this.pulses) {
      if (at < p.duration) return { light: p.on ? 1 : 0, completed: false }
      at -= p.duration
    }
    return { light: 0, completed: false }
  }
  get state(): string { return this.mode }
}
