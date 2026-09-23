/**
 * atmosphere.ts — туман, небо, свет неба и цепочка кадра.
 *
 * Все числа внешнего вида, которые не про конкретную вещь, живут здесь:
 * туман, свет неба, экспозиция, свечение, цветокор, зерно. Подбираются они
 * по числам эталона кадра (`story/vigil/ref/measure.py`), а не на глаз
 * (look.md, «Эталон кадра»).
 *
 * Крючки появления мира (`awaken.ts`) держатся за это же устройство:
 *
 *   - пелена - МНОЖИТЕЛЬ плотности тумана, а не присваивание: плотность
 *     каждый кадр собирается из погоды, пелены и вспышки;
 *   - свет - экспозиция в цепочке. Тонмаппинг рендерера здесь не работает
 *     вовсе: сцена рисуется в буфер композера, поэтому экспозиция и кривая
 *     стоят в цепочке эффектов, в этом порядке.
 *
 * Цепочка кадра - два полноэкранных прохода, а не десять: дешёвые эффекты
 * слиты (каждый проход на телефоне дороже любой математики внутри него).
 *
 *   1. свечение, экспозиция, AgX, цветокор;
 *   2. сглаживание, виньетка, зерно, дизеринг - последним звеном: в тёмном
 *      монохромном тумане без него идут полосы.
 */

import * as THREE from 'three'
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing'
import { createSky } from './weather/sky'
import { FLASH } from './world/shared'

export const SETTINGS = {
  /** Туман и небо над кронами: медиана этого участка на эталонном кадре. */
  fogColor: 0x113537,
  /** FogExp2: видимость падает как exp(-(d*x)^2). Подобрано по эталону кадра. */
  fogDensity: 0.03,
  /** Низовой туман: гуще ниже этой высоты, м, и во столько раз от основного. */
  lowFogTop: 1.5,
  lowFog: 0.35,
  /** Свет неба: сверху бирюза, снизу почти чёрная грязь. */
  skyTop: 0x2c5a58,
  skyGround: 0x0b1110,
  skyLight: 0.55,
  exposure: 1.0,
  /** Свечение: порог после экспозиции, сила, радиус. */
  bloomThreshold: 0.8,
  bloom: 1.2,
  bloomRadius: 0.6,
  /** Цветокор lift / gamma / gain, линейный: тени в бирюзу. */
  lift: [0.003, 0.009, 0.0085] as [number, number, number],
  gamma: [1.0, 1.0, 1.0] as [number, number, number],
  gain: [1.0, 1.0, 1.0] as [number, number, number],
  vignetteOffset: 0.35,
  vignette: 0.45,
  grain: 0.05,
  /** Масштаб рендера: доля от пикселей устройства. */
  renderScale: { desktop: 0.75, phone: 0.6 },
  /** Вспышка молнии: во сколько раз светлеет туман и растёт свет неба. */
  flashFog: 1.6,
  flashSky: 6,
  flashExposure: 0.25,
} as const

/** Цвет, к которому пелена ведёт туман: фон страницы, почти чёрный. */
const VEIL_DARK = 0x050b0a

// --- Низовой туман ---------------------------------------------------------------
// Общие куски шейдеров three правятся один раз, до первой компиляции: так
// низовой туман получают все материалы мира разом, без правки каждого.
// Шейдеры капель тумана считают сами и эти куски не берут.
THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif
`
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  {
    vec4 fogW = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      fogW = instanceMatrix * fogW;
    #endif
    vFogWorld = ( modelMatrix * fogW ).xyz;
  }
#endif
`
THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  float lowFogHash( vec2 p ) { return fract( sin( dot( p, vec2( 41.3, 289.1 ) ) ) * 43758.5453 ); }
  float lowFogNoise( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( lowFogHash( i ), lowFogHash( i + vec2( 1, 0 ) ), f.x ),
                mix( lowFogHash( i + vec2( 0, 1 ) ), lowFogHash( i + vec2( 1, 1 ) ), f.x ), f.y );
  }
#endif
`
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    // Низовой слой: гуще у земли, высота слоя гуляет шумом по поляне.
    float lowTop = ${SETTINGS.lowFogTop.toFixed(2)} * ( 0.6 + 0.8 * lowFogNoise( vFogWorld.xz * 0.12 ) );
    float low = 1.0 - smoothstep( 0.0, lowTop, vFogWorld.y );
    fogFactor = 1.0 - ( 1.0 - fogFactor ) * exp( - fogDensity * ${SETTINGS.lowFog.toFixed(2)} * low * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`

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

/** Цветокор формулой, без таблиц: lift / gamma / gain по каналам. */
class GradeEffect extends Effect {
  constructor() {
    super(
      'Grade',
      `uniform vec3 lift;
       uniform vec3 gamma;
       uniform vec3 gain;
       void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
         vec3 c = max(inputColor.rgb, 0.0);
         c = gain * (c + lift * (1.0 - c));
         c = pow(max(c, 0.0), 1.0 / gamma);
         outputColor = vec4(c, inputColor.a);
       }`,
      {
        uniforms: new Map<string, THREE.Uniform>([
          ['lift', new THREE.Uniform(new THREE.Vector3(...SETTINGS.lift))],
          ['gamma', new THREE.Uniform(new THREE.Vector3(...SETTINGS.gamma))],
          ['gain', new THREE.Uniform(new THREE.Vector3(...SETTINGS.gain))],
        ]),
      },
    )
  }
}

/**
 * Последнее звено: виньетка, зерно и дизеринг. Зерно и дизеринг - шум
 * interleaved gradient по координате пикселя; дизеринг добавляется в
 * пространстве экрана (sRGB), где и живут ступени восьмибитного цвета.
 */
class FinishEffect extends Effect {
  constructor() {
    super(
      'Finish',
      `uniform float vignetteOffset;
       uniform float vignetteDarkness;
       uniform float grain;
       uniform float frame;
       float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
       vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
       vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
       void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
         vec3 c = max(inputColor.rgb, 0.0);
         vec2 d = (uv - 0.5) * 2.0;
         float v = smoothstep(0.0, 1.0, clamp(length(d) * 0.7071 - vignetteOffset + 0.5, 0.0, 1.0));
         c *= 1.0 - vignetteDarkness * v * v;
         vec2 px = gl_FragCoord.xy + vec2(frame * 5.588238, frame * 3.1);
         vec3 s = toSrgb(c);
         s += (ign(px) - 0.5) * grain * (0.35 + s);
         s += (ign(px.yx + 17.0) - 0.5) / 255.0;
         outputColor = vec4(toLinear(clamp(s, 0.0, 1.0)), inputColor.a);
       }`,
      {
        uniforms: new Map<string, THREE.Uniform>([
          ['vignetteOffset', new THREE.Uniform(SETTINGS.vignetteOffset)],
          ['vignetteDarkness', new THREE.Uniform(SETTINGS.vignette)],
          ['grain', new THREE.Uniform(SETTINGS.grain)],
          ['frame', new THREE.Uniform(0)],
        ]),
      },
    )
  }
  update(): void {
    const f = this.uniforms.get('frame')!
    f.value = (f.value + 1) % 64
  }
}

export type Atmosphere = ReturnType<typeof createAtmosphere>

export function createAtmosphere(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  opts: { phone: boolean },
) {
  const fogBase = new THREE.Color(SETTINGS.fogColor)
  const fogDark = new THREE.Color(VEIL_DARK)
  const fog = new THREE.FogExp2(SETTINGS.fogColor, SETTINGS.fogDensity)
  scene.fog = fog
  scene.background = fog.color

  const sky = createSky(fog.color)
  scene.add(sky.mesh)

  const hemi = new THREE.HemisphereLight(SETTINGS.skyTop, SETTINGS.skyGround, SETTINGS.skyLight)
  hemi.name = 'sky-light'
  scene.add(hemi)

  renderer.toneMapping = THREE.NoToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType })
  composer.addPass(new RenderPass(scene, camera))
  const exposure = new ExposureEffect(SETTINGS.exposure)
  const bloom = new BloomEffect({
    blendFunction: BlendFunction.ADD,
    luminanceThreshold: SETTINGS.bloomThreshold / SETTINGS.exposure,
    luminanceSmoothing: 0.1,
    intensity: SETTINGS.bloom,
    radius: SETTINGS.bloomRadius,
    mipmapBlur: true,
    resolutionScale: opts.phone ? 0.5 : 1,
  })
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX })
  const grade = new GradeEffect()
  composer.addPass(new EffectPass(camera, bloom, exposure, tone, grade))
  const finish = new FinishEffect()
  composer.addPass(new EffectPass(camera, new FXAAEffect(), finish))

  // Состояние пелены и вспышки. Живёт здесь, применяется в `update`.
  let veilTimes = 1
  let veilDark = 0
  let light = 1
  let density: number = SETTINGS.fogDensity

  function setVeil(densityTimes: number, darkness: number): void {
    veilTimes = densityTimes
    veilDark = darkness
  }

  function setLight(multiplier: number): void {
    light = multiplier
  }

  const flashFog = new THREE.Color()

  /** Раз в кадр: туман, небо и экспозиция из погоды, пелены и вспышки. */
  function update(_dt: number): void {
    const f = FLASH.value
    fog.density = density * veilTimes
    flashFog.copy(fogBase).multiplyScalar(1 + (SETTINGS.flashFog - 1) * f)
    fog.color.copy(flashFog).lerp(fogDark, veilDark)
    hemi.intensity = SETTINGS.skyLight * (1 + SETTINGS.flashSky * f)
    exposure.exposure = SETTINGS.exposure * light * (1 + SETTINGS.flashExposure * f)
    sky.follow(camera)
    finish.update()
  }

  update(0)

  return {
    composer,
    fog,
    sky,
    hemi,
    setVeil,
    setLight,
    /** Штатная плотность тумана: буря её держит, ясное небо опускает. */
    setDensity(v: number): void {
      density = v
    },
    update,
    /** Какой масштаб рендера у этого устройства. */
    renderScale: opts.phone ? SETTINGS.renderScale.phone : SETTINGS.renderScale.desktop,
  }
}
