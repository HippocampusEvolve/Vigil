/** Neutral, deterministic item actions. Story rules consume emitted events later. */
export type Target = 'flashlight' | 'intercom' | 'journal' | 'pen' | 'console' |
  'generator:filler' | 'generator:lever' | 'crate' | 'wheel' | 'tarp' |
  'climate:lever' | 'lamp:switch' | `note:${string}`

export type ActionEvent = { kind: string; id?: string; value?: number }

export class Actions {
  readonly story: boolean
  flashlight = false
  door = false
  note: string | null = null
  journal = -1
  channel = 0
  headphones = false
  tapePlayed = false
  tapeFinished = false
  fuel = false
  pulls = 0
  crate = 0
  wheel = false
  tarp = false
  automatic = false
  lamp = true
  written = false

  constructor(story: boolean) { this.story = story }

  get pose(): boolean { return this.note !== null || this.journal >= 0 || this.headphones }

  /** Walking away exits a station; the note stays in the hand until returned. */
  leave(): ActionEvent[] {
    const events: ActionEvent[] = []
    if (this.journal >= 0) { this.journal = -1; events.push({ kind: 'journal:close' }) }
    if (this.headphones) { this.headphones = false; events.push({ kind: 'console:leave' }) }
    return events
  }

  finishTape(): ActionEvent[] {
    if (!this.tapePlayed || this.tapeFinished) return []
    this.tapeFinished = true
    return [{ kind: 'tape:end' }]
  }

  verb(target: Target): string | null {
    if (this.note) return target === `note:${this.note}` ? 'положить' : null
    if (this.journal >= 0) return target === 'journal' ? (this.journal < 5 ? 'листать' : 'закрыть') : null
    if (this.headphones && target !== 'console') return null
    if (target.startsWith('note:')) return this.story ? 'читать' : null
    switch (target) {
      case 'flashlight': return this.flashlight ? null : 'взять'
      case 'intercom': return this.door ? null : 'нажать'
      case 'journal': return this.story ? 'читать' : null
      case 'pen': return this.story && !this.written ? 'написать' : null
      case 'console': return 'слушать'
      case 'generator:filler': return this.fuel ? null : 'долить'
      case 'generator:lever': return this.fuel && this.pulls < 3 ? 'тянуть' : null
      case 'crate': return this.crate < 3 ? 'толкать' : null
      case 'wheel': return this.crate === 3 && !this.wheel ? 'открыть' : null
      case 'tarp': return this.tarp ? null : 'снять'
      case 'climate:lever': return this.story && this.tarp && !this.automatic ? 'перевести' : null
      case 'lamp:switch': return this.story ? (this.lamp ? 'погасить' : 'зажечь') : null
    }
    return null
  }

  act(target: Target): ActionEvent[] {
    const verb = this.verb(target)
    if (!verb) return []
    if (target.startsWith('note:')) {
      const id = target.slice(5)
      this.note = this.note ? null : id
      return [{ kind: this.note ? 'read:open' : 'read:close', id }]
    }
    switch (target) {
      case 'flashlight': this.flashlight = true; return [{ kind: 'pick', id: target }]
      case 'intercom': this.door = true; return [{ kind: 'use', id: target }]
      case 'journal':
        if (this.journal < 0) { this.journal = 0; return [{ kind: 'journal:open' }] }
        if (this.journal < 5) { this.journal++; return [{ kind: 'journal:page', value: this.journal }] }
        this.journal = -1; return [{ kind: 'journal:close' }]
      case 'pen': this.written = true; return [{ kind: 'write' }]
      case 'console':
        if (!this.headphones) { this.headphones = true; this.channel = 1; return [{ kind: 'console:wear' }, { kind: 'channel', value: 1 }] }
        this.channel = this.channel % 6 + 1
        if (this.channel === 4 && this.story && !this.tapePlayed) {
          this.tapePlayed = true
          return [{ kind: 'channel', value: 4 }, { kind: 'tape:start' }]
        }
        return [{ kind: 'channel', value: this.channel }]
      case 'generator:filler': this.fuel = true; return [{ kind: 'fuel' }]
      case 'generator:lever':
        this.pulls++
        return [{ kind: 'pull', value: this.pulls }, ...(this.pulls === 3 ? [{ kind: 'power:on' }] : [])]
      case 'crate': this.crate++; return [{ kind: 'push', value: this.crate }]
      case 'wheel': this.wheel = true; return [{ kind: 'open', id: target }]
      case 'tarp': this.tarp = true; return [{ kind: 'remove', id: target }]
      case 'climate:lever': this.automatic = true; return [{ kind: 'mode:auto' }]
      case 'lamp:switch': this.lamp = !this.lamp; return [{ kind: 'lamp:toggle', value: this.lamp ? 1 : 0 }]
    }
    return []
  }
}
