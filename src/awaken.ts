/**
 * awaken.ts — вход в мир как пробуждение, а не как переключатель.
 *
 * Общий файл миров find-the-end.fun, перенесён из Winter Tower копией
 * (docs/games.md, «Появление мира»). Своё у этого мира два: игрок не просто
 * поднимает взгляд, а встаёт с земли. Глаз начинает у самой земли и за время
 * пробуждения поднимается до роста (`eye`, `setEye`), а взгляд, опущенный в
 * землю, находит лампу (`yaw`, `pitch`) и собирается на ней: угол обзора
 * сужается (`fov`, `setFov`). Раскрывается он потом сам - тело ведёт камеру
 * к своему углу медленно (`fovRate` в player.ts).
 *
 * Простая идея. Мир проступает из темноты сквозь плотную пелену; за титулом
 * он виден, но далёк и приглушён; по нажатию пелена отходит вглубь, свет
 * набирает силу, а опущенный взгляд поднимается и находит главное в мире.
 * Ожидание загрузки никуда не девается - оно становится появлением.
 *
 * Туман здесь настоящий, а не картинка поверх кадра. `FogExp2` гасит цвет по
 * расстоянию, поэтому плотная пелена открывает сначала близкое и лишь потом
 * дальнее: она именно ОТХОДИТ вглубь, а не растворяется равномерно.
 *
 * ГЛАВНОЕ ПРАВИЛО: длительность не зависит от того, успело ли что-то
 * загрузиться. Пробуждение идёт свои секунды всегда, а если мир к их концу ещё
 * не готов - пелена держится, пока не будет. Иначе на быстрой машине рывок
 * вернулся бы, только с другой стороны.
 *
 * ВТОРОЕ ПРАВИЛО, и оно про отклик: нажатие принимается ВСЕГДА. Пробуждение
 * начинается из ТОЙ ТОЧКИ, где застало нажатие: пелена, свет, взгляд и
 * высота глаза ведутся не от табличных значений ступени, а от текущих. Подъём
 * при этом всегда идёт полностью и всегда доходит до конца.
 *
 * Пока идёт пробуждение, игрок не управляет ничем: он приходит в себя.
 * Поэтому цикл в это время не зовёт ни физику, ни взгляд - камерой ведёт этот
 * модуль. Заодно это снимает старую опасность: войти раньше, чем собрано
 * дерево коллизий, и провалиться сквозь пол первым же шагом.
 */

import type { Look } from './look'

/** Сколько длится проявление мира из темноты за титулом. */
const REVEAL_MS = 1400

/** Сколько длится пробуждение после нажатия. */
const WAKE_MS = 2600

/**
 * Во сколько раз плотнее тумана нормы.
 *
 * `dark` — почти ничего не видно, только ближайшее; с этого начинается первый
 * кадр. `veil` — мир за титулом: силуэты читаются, глубины нет.
 */
const FOG_DARK = 9
const FOG_VEIL = 3.4

/** Насколько туман затемнён на тех же двух ступенях: 1 — почти чёрный. */
const TINT_DARK = 1
const TINT_VEIL = 0.55

/** Во сколько раз приглушён свет на тех же двух ступенях. */
const LIGHT_DARK = 0
const LIGHT_VEIL = 0.4

/** Насколько опущен взгляд в начале пробуждения, радианы. */
const PITCH_DOWN = -0.42

/** На сколько взгляд отведён в сторону от того, что должен найти. */
const YAW_ASIDE = -0.17

/**
 * Какую долю пробуждения глаз ещё у земли. Сперва поднимается голова, потом
 * встаёт тело: подъём с одновременным поворотом взгляда читается как лифт.
 */
const RISE_LAG = 0.15

/** Плавность: медленно трогается, медленно останавливается. */
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Плавность для света: трогается сразу, мягко приходит. Темнота не должна залипать. */
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)

/** Смесь с точными концами: при t = 1 ровно b, а не b с ошибкой округления. */
const mix = (a: number, b: number, t: number): number => a * (1 - t) + b * t

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t))

export type Awakening = {
  /** Вести анимацию. Зовётся каждый кадр, раньше всего остального. */
  update(dt: number): void
  /** Мир проступает из темноты. Зовётся на первом кадре, под заставкой. */
  reveal(): void
  /**
   * Игрок нажал «войти»: пелена отходит, взгляд поднимается, тело встаёт.
   *
   * Принимается из любой фазы до пробуждения. Возвращает `false`, только если
   * пробуждение уже идёт или кончилось.
   */
  enter(): boolean
  /** Держит ли пробуждение управление. Пока держит — физику не трогаем. */
  holds(): boolean
}

export function createAwakening(opts: {
  /** Пелена: во сколько раз плотнее штатного тумана и насколько он затемнён. */
  setVeil(densityTimes: number, darkness: number): void
  /** Яркость кадра. Отдаётся атмосферой отдельно от её настроек. */
  setLight(multiplier: number): void
  look: Look
  /** Куда смотреть, когда глаза открылись: направление, заданное миром. */
  yaw: number
  /** Наклон взгляда в конце, радианы; по умолчанию горизонт. */
  pitch?: number
  /** Высота глаза над ступнёй в начале и в конце пробуждения, м. */
  eye: { from: number; to: number }
  /** Поставить глаз на высоту над ступнёй. Цикл тело не зовёт - ставим сами. */
  setEye(height: number): void
  /** Угол обзора по вертикали в начале и в конце пробуждения, градусы. */
  fov?: { from: number; to: number }
  /** Поставить угол обзора камеры. */
  setFov?(deg: number): void
  /** Громкость мира: 0 — тишина, 1 — как задумано. */
  setSound(level: number): void
  /** Готов ли мир пустить игрока — дерево коллизий собрано. */
  ready(): boolean
}): Awakening {
  let phase: 'dark' | 'reveal' | 'veiled' | 'waking' | 'awake' = 'dark'
  let elapsed = 0
  const pitch = opts.pitch ?? 0

  // Что стоит в кадре сейчас и что стояло в момент нажатия. Нажать могут в
  // любой момент проявления: тогда пелена отходит от того, что игрок видит,
  // а не прыгает сперва к табличной ступени.
  let curFog = FOG_DARK
  let curTint = TINT_DARK
  let curLight = LIGHT_DARK
  let curAim = 0
  let curRise = 0
  let fogAtEnter = FOG_VEIL
  let tintAtEnter = TINT_VEIL
  let lightAtEnter = LIGHT_VEIL
  let aimAtEnter = 0
  let riseAtEnter = 0

  /** Поставить пелену, свет и звук по доле пути между ступенями. */
  function set(fogTimes: number, dark: number, light: number, sound = 0): void {
    curFog = fogTimes
    curTint = dark
    curLight = light
    opts.setVeil(fogTimes, dark)
    opts.setLight(light)
    opts.setSound(sound)
  }

  /** Повести взгляд: t = 0 — опущен и отведён, t = 1 — на месте. */
  function aim(t: number): void {
    curAim = t
    opts.look.setYaw(mix(opts.yaw + YAW_ASIDE, opts.yaw, t), mix(PITCH_DOWN, pitch, t))
  }

  /** Поднять глаз: t = 0 — у земли, t = 1 — рост. */
  function rise(t: number): void {
    curRise = t
    opts.setEye(mix(opts.eye.from, opts.eye.to, t))
  }

  /** Собрать взгляд: t = 0 — рассеян, t = 1 — на лампе. */
  function focus(t: number): void {
    if (opts.fov && opts.setFov) opts.setFov(mix(opts.fov.from, opts.fov.to, t))
  }

  // Первый кадр рисуется в темноте и под плотной пеленой: мир уже собран, но
  // его ещё не видно. Иначе он возникает готовым, и это тот самый рывок.
  set(FOG_DARK, TINT_DARK, LIGHT_DARK)
  aim(0)
  rise(0)
  focus(0)

  return {
    reveal() {
      if (phase !== 'dark') return
      phase = 'reveal'
      elapsed = 0
    },

    enter() {
      if (phase === 'waking' || phase === 'awake') return false
      // Снимок кадра, на котором нажали: от него и поведём.
      fogAtEnter = curFog
      tintAtEnter = curTint
      lightAtEnter = curLight
      aimAtEnter = curAim
      riseAtEnter = curRise
      phase = 'waking'
      elapsed = 0
      return true
    },

    holds() {
      return phase !== 'awake'
    },

    update(dt) {
      if (phase === 'awake') return
      elapsed += dt * 1000

      if (phase === 'waking') {
        const t = Math.min(elapsed / WAKE_MS, 1)
        const k = ease(t)
        // Начальные значения сняты с кадра, на котором нажали, а не взяты из
        // таблицы: иначе вход из темноты давал бы вспышку до ступени `veiled`.
        set(mix(fogAtEnter, 1, k), mix(tintAtEnter, 0, k), mix(lightAtEnter, 1, k), easeOut(t))
        aim(mix(aimAtEnter, 1, k))
        rise(mix(riseAtEnter, 1, ease(clamp01((t - RISE_LAG) / (1 - RISE_LAG)))))
        // Взгляд собирается на лампе во второй половине: сперва найти, потом вглядеться.
        focus(ease(clamp01((t - 0.35) / 0.65)))
        // Время вышло, но мир ещё не готов — держим последний кадр пелены,
        // а не отдаём управление в недособранный мир.
        if (t >= 1 && opts.ready()) {
          set(1, 0, 1, 1)
          aim(1)
          rise(1)
          focus(1)
          phase = 'awake'
        }
        return
      }

      // До нажатия глаз стоит у земли каждый кадр, а не один раз: кто-то
      // (перенос тела, сейв) может поставить камеру на рост раньше времени.
      rise(curRise)

      if (phase === 'reveal') {
        const t = Math.min(elapsed / REVEAL_MS, 1)
        set(
          mix(FOG_DARK, FOG_VEIL, ease(t)),
          mix(TINT_DARK, TINT_VEIL, ease(t)),
          mix(LIGHT_DARK, LIGHT_VEIL, easeOut(t)),
        )
        if (t >= 1) phase = 'veiled'
      }
    },
  }
}
