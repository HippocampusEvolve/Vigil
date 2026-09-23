/**
 * ambient.ts — звук мира: один аудиоконтекст и общая громкость.
 *
 * Весь звук мира будет синтезом на WebAudio, без единого файла. Здесь пока
 * только то, на чём он будет держаться: контекст, который рождается по первому
 * жесту, мастер-громкость и крючок появления мира `setWake`.
 *
 * Уровень появления запоминается здесь, а не пишется в узел сразу: контекст
 * может завестись позже конца появления, и тогда мир остался бы немым
 * насовсем. Узел получает запомненное значение при рождении и потом в
 * каждом `update`.
 */

export type Ambient = ReturnType<typeof createAmbient>

/** Постоянная сглаживания громкости, с: смена уровня без щелчка. */
const GAIN_TAU = 0.05

export function createAmbient() {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let wake = 1
  let written = -1

  /** Запускается по первому жесту пользователя. Повторные вызовы безвредны. */
  function start(): void {
    if (ctx) {
      // `interrupted` - состояние Safari после звонка: лечится тем же resume.
      if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => {})
      return
    }
    ctx = new AudioContext()
    // Ушли со вкладки - замолкаем, вернулись - поднимаем контекст.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!ctx) return
        if (document.hidden) void ctx.suspend().catch(() => {})
        else if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => {})
      })
    }
    master = ctx.createGain()
    master.gain.value = wake
    written = wake
    master.connect(ctx.destination)
  }

  function update(_dt: number): void {
    if (!ctx || !master || wake === written) return
    master.gain.setTargetAtTime(wake, ctx.currentTime, GAIN_TAU)
    written = wake
  }

  return {
    start,
    update,
    /** Громкость появления: 0 - тишина, 1 - как задумано. */
    setWake(v: number): void {
      wake = v
    },
    /** Контекст и шина для разовых звуков. Второй контекст заводить нельзя. */
    get bus(): { ctx: AudioContext; out: GainNode } | null {
      return ctx && master && ctx.state === 'running' ? { ctx, out: master } : null
    },
    get state(): string {
      return ctx ? ctx.state : 'не запущен'
    },
  }
}
