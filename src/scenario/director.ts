/** One smoothed intensity value drives sound, image treatment and tool flicker. */
export class TensionDirector {
  value = 0.25
  target = 0.25
  private from = 0.25
  private elapsed = 0
  private duration = 0
  set(value: number): void {
    const next = Math.max(0, Math.min(1, value))
    if (next === this.target) return
    this.from = this.value
    this.target = next
    this.elapsed = 0
    this.duration = next > this.value ? 2 : 6
  }
  update(dt: number): number {
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt))
    this.value = this.duration ? this.from + (this.target - this.from) * (this.elapsed / this.duration) : this.target
    return this.value
  }
  get heart(): number { return Math.max(0, (this.value - 0.5) / 0.5) }
  get breath(): number { return Math.max(0, (this.value - 0.4) / 0.6) }
  get hum(): number { return Math.max(0, (this.value - 0.5) / 0.3) }
  get flicker(): number { return Math.max(0, (this.value - 0.8) / 0.2) }
}
