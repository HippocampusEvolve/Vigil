/**
 * weather/index.ts — погода мира: ливень и молнии.
 *
 * Держит время дождя (по нему капает, рябит лужа и кивает лист), ливень
 * вокруг камеры и расписание молний. Вспышку отдаёт в общий юниформ
 * `FLASH`: по нему светлеют небо, туман и свет неба (atmosphere.ts), капли
 * и отсвет. Гром заводит тот, кто передал `onThunder`, - это звук.
 *
 * Молнии идут только после пробуждения: первый кадр после появления обязан
 * совпасть с эталоном, и первая молния - не раньше 45 с от входа.
 */

import type * as THREE from 'three'
import { createRain } from './rain'
import { createLightning, type Strike } from './lightning'
import { FLASH, RAIN_TIME } from '../world/shared'

/** Семя молний: одно на мир, чтобы прохождение было повторимо. */
const SEED = 3312

/** Струй дождя по качеству: компьютер и телефон (look.md, «Телефон»). */
export const RAIN_COUNT = { high: 10000, medium: 7000, low: 4000 } as const

export type Weather = ReturnType<typeof createWeather>

export function createWeather(opts: {
  quality: keyof typeof RAIN_COUNT
  /** Небо: куда ударило и насколько ярче купол. */
  onStrike?(s: Strike): void
  /** Звук грома: через сколько после вспышки и близкий ли. */
  onThunder?(delay: number, near: boolean): void
}) {
  const rain = createRain(RAIN_COUNT[opts.quality])
  const lightning = createLightning(SEED, (s) => {
    opts.onStrike?.(s)
    opts.onThunder?.(s.delay, s.near)
  })

  return {
    group: rain.group,
    rain,
    lightning,
    /** Раз в кадр. `awake` - игрок уже в мире: до того молний нет. */
    update(dt: number, camera: THREE.Camera, awake: boolean): void {
      RAIN_TIME.value += dt
      rain.update(camera)
      FLASH.value = awake ? lightning.update(dt) : 0
    },
  }
}
