/**
 * atmosphere.ts — туман, небо и цепочка пост-обработки.
 *
 * Заготовка: туман, экспозиция и тонмаппинг. Погода и полная цепочка кадра
 * придут поверх этого же устройства, а крючки появления мира (`awaken.ts`)
 * уже держатся за него:
 *
 *   - пелена - МНОЖИТЕЛЬ плотности тумана, а не присваивание. Плотность
 *     будет каждый кадр пересчитывать погода, и присвоенное появлением
 *     значение она стёрла бы на следующем же кадре;
 *   - свет - экспозиция в композере. Тонмаппинг рендерера здесь не работает
 *     вовсе: сцена рисуется в буфер композера, а он применяется только при
 *     выводе прямо на экран. Поэтому экспозиция и тонмаппинг стоят в цепочке
 *     эффектов, в этом порядке.
 */

import * as THREE from 'three'
import {
  Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing'

const SETTINGS = {
  /** Туман и небо над кронами: медиана этого участка на эталонном кадре. */
  fogColor: 0x113537,
  /** FogExp2: видимость падает как exp(-(d*x)^2). На 25 м остаётся половина. */
  fogDensity: 0.035,
  exposure: 1.0,
}

/** Цвет, к которому пелена ведёт туман: фон страницы, почти чёрный. */
const VEIL_DARK = 0x050b0a

/** Экспозиция отдельным эффектом: у рендерера она в композере не срабатывает. */
class ExposureEffect extends Effect {
  constructor(exposure: number) {
    super(
      'Exposure',
      `uniform float exposure;
       void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
         outputColor = vec4(inputColor.rgb * exposure, inputColor.a);
       }`,
      { uniforms: new Map([['exposure', new THREE.Uniform(exposure)]]) },
    )
  }

  set exposure(v: number) {
    this.uniforms.get('exposure')!.value = v
  }
}

export type Atmosphere = ReturnType<typeof createAtmosphere>

export function createAtmosphere(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
) {
  const fog = new THREE.FogExp2(SETTINGS.fogColor, SETTINGS.fogDensity)
  scene.fog = fog
  scene.background = new THREE.Color(SETTINGS.fogColor)

  renderer.toneMapping = THREE.NoToneMapping
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType })
  composer.addPass(new RenderPass(scene, camera))
  const exposure = new ExposureEffect(SETTINGS.exposure)
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
  composer.addPass(new EffectPass(camera, exposure, tone))

  const fogBase = new THREE.Color(SETTINGS.fogColor)
  const fogDark = new THREE.Color(VEIL_DARK)

  // Состояние пелены. Живёт здесь, а применяется в `update`: плотность тумана
  // собирается каждый кадр из погоды и множителя, а не пишется разово.
  let veilTimes = 1
  let veilDark = 0

  /**
   * Пелена входа: плотность в разах от штатной и затемнение 0..1.
   * Временное состояние появления мира, а не настройка атмосферы.
   */
  function setVeil(densityTimes: number, darkness: number): void {
    veilTimes = densityTimes
    veilDark = darkness
  }

  /** Яркость кадра: 1 - как задумано, 0 - черно. Тоже только для появления. */
  function setLight(multiplier: number): void {
    exposure.exposure = SETTINGS.exposure * multiplier
  }

  /** Раз в кадр: собрать туман из штатного значения и пелены. */
  function update(_dt: number): void {
    fog.density = SETTINGS.fogDensity * veilTimes
    fog.color.copy(fogBase).lerp(fogDark, veilDark)
    ;(scene.background as THREE.Color).copy(fog.color)
  }

  update(0)

  return { composer, fog, setVeil, setLight, update }
}
