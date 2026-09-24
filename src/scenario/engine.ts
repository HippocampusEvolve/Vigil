/** Data driven, deterministic event executor. No story names or prose live here. */
export type Command = readonly [kind: string, value?: string | number]
export type Gate = { event: string; all?: string[]; any?: string[]; not?: string[] }
export type Rule = { id: string; when: Gate; after?: number; do: Command[] }
export type Nudge = { id: string; from: string; after: number; every?: number; while: Gate; do: Command[] }
export type Script = { flags: Record<string, number>; rules: Rule[]; nudges?: Nudge[]; access?: Record<string, Omit<Gate, 'event'>> }
export type Fired = { id: string; commands: Command[] }
type Pending = { at: number; rule: Rule }
type Hint = { at: number; nudge: Nudge }

export class Scenario {
  readonly flags = new Set<string>()
  readonly fired = new Set<string>()
  readonly seen = new Set<string>()
  private pending: Pending[] = []
  private hints: Hint[] = []
  private time = 0
  constructor(readonly data: Script | undefined, initial: Iterable<string> = [], private readonly onFire: (f: Fired) => void = () => {}) {
    for (const flag of initial) if (data?.flags[flag]) this.flags.add(flag)
    this.validate()
  }
  private validate(): void {
    if (!this.data) return
    const ids = new Set<string>()
    const numbers = new Set<number>()
    for (const [name, number] of Object.entries(this.data.flags)) {
      if (!Number.isInteger(number) || number < 1 || number > 65535 || numbers.has(number)) throw Error(`invalid flag number: ${name}`)
      numbers.add(number)
    }
    for (const rule of this.data.rules) {
      if (ids.has(rule.id) || !rule.when.event || (rule.after ?? 0) < 0) throw Error(`invalid rule: ${rule.id}`)
      ids.add(rule.id)
      for (const name of [...(rule.when.all ?? []), ...(rule.when.any ?? []), ...(rule.when.not ?? [])]) if (!this.data.flags[name]) throw Error(`unknown gate flag: ${name}`)
      for (const [kind, value] of rule.do) if (kind === 'flag' && typeof value === 'string' && !this.data.flags[value]) throw Error(`unknown flag: ${value}`)
    }
    for (const gate of Object.values(this.data.access ?? {})) for (const name of [...(gate.all ?? []), ...(gate.any ?? []), ...(gate.not ?? [])]) if (!this.data.flags[name]) throw Error(`unknown access flag: ${name}`)
  }
  has(flag: string): boolean { return this.flags.has(flag) }
  allows(target: string): boolean {
    const gate = this.data?.access?.[target]
    return !gate || this.gate({ ...gate, event: target }, target)
  }
  private gate(gate: Gate, event: string): boolean {
    return gate.event === event &&
      (gate.all ?? []).every((f) => this.has(f)) &&
      (!(gate.any?.length) || gate.any.some((f) => this.has(f))) &&
      (gate.not ?? []).every((f) => !this.has(f))
  }
  private execute(rule: Rule): void {
    if (this.fired.has(rule.id)) return
    this.fired.add(rule.id)
    for (const [kind, value] of rule.do) if (kind === 'flag' && typeof value === 'string') this.flags.add(value)
    this.onFire({ id: rule.id, commands: rule.do })
  }
  emit(event: string): void {
    if (!this.data) return
    this.seen.add(event)
    for (const rule of this.data.rules) {
      if (this.fired.has(rule.id) || this.pending.some((p) => p.rule.id === rule.id) || !this.gate(rule.when, event)) continue
      if (rule.after) this.pending.push({ at: this.time + rule.after, rule })
      else this.execute(rule)
    }
    for (const nudge of this.data.nudges ?? []) if (nudge.from === event && !this.hints.some((h) => h.nudge.id === nudge.id)) this.hints.push({ at: this.time + nudge.after, nudge })
  }
  update(dt: number): void {
    if (!this.data || !Number.isFinite(dt) || dt < 0) return
    this.time += dt
    for (const item of [...this.pending]) if (item.at <= this.time) {
      this.pending.splice(this.pending.indexOf(item), 1)
      this.execute(item.rule)
    }
    for (const item of [...this.hints]) if (item.at <= this.time) {
      const { nudge } = item
      if (this.gate(nudge.while, nudge.while.event)) this.onFire({ id: nudge.id, commands: nudge.do })
      if (nudge.every && this.gate(nudge.while, nudge.while.event)) item.at = this.time + nudge.every
      else this.hints.splice(this.hints.indexOf(item), 1)
    }
  }
}
