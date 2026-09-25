/**
 * main.ts — точка входа: рендерер, мир, игрок, погода, цикл.
 *
 * Управление целиком из общего ядра миров (`world-core/core`): тело, взгляд,
 * ввод. Мир отдаёт телу только свою форму (`support.ts`) и свои числа
 * (`player.ts`). Оболочка входа, появление, прогрев и цикл устроены так же,
 * как в Winter Tower, и там же объяснено почему (docs/games.md).
 *
 * Своё у этого мира - сборка по шагам. Лес, земля и пост одним куском не
 * влезают в 60 мс самой долгой задачи входа, поэтому мир собирается
 * генератором (world/index.ts), а здесь между шагами поток отдаётся
 * браузеру: полоса загрузки движется, кнопки отвечают.
 */

// Штамп версии и полоса загрузки стоят раньше всего остального: оба ставят
// перехватчики на общий загрузчик three, и позже они пропустили бы часть счёта.
// Импорт ради побочного эффекта.
import './asset'
import './loading'

// Вехи загрузки уходят в трассу boot.js (`__FTE_BOOT__.trace()` в консоли).
// Второй аргумент - подпись под полосой, и она человеческая: полоса
// рассказывает, что мир собирает сейчас, а не показывает имена внутренних
// шагов. Таблица живёт ЗДЕСЬ, а не в оболочке: вехи у каждого мира свои.
const STAGE: Record<string, string> = {
  земля: 'лес',
  пост: 'пост',
  лес: 'лес',
  'мир собран': 'пост',
  'дерево коллизий': 'пост',
  'прогрев начат': 'дождь',
}
const mark = (name: string): void =>
  (
    window as Window & { __FTE_BOOT__?: { mark(n: string, label?: string): void } }
  ).__FTE_BOOT__?.mark(name, STAGE[name] ?? (name.startsWith('прогрев кончен') ? 'звук' : undefined))

import * as THREE from 'three'

import { Body, Input, SmoothLook } from 'world-core/core'
import { createShell } from './shell'
import { keepOffline } from './offline'
import { createAtmosphere, type Atmosphere } from './atmosphere'
import { createAmbient } from './ambient'
import { createAwakening, type Awakening } from './awaken'
import { createSupport, STEP_UP, type Surface } from './support'
import { createTouch, touchForced, touchSupported, type Touch } from './touch'
import { BODY, LOOK } from './player'
import { layer } from './layer'
import { Actions } from './actions/state'
import { StepTrack } from './actions/tape'
import type { createInteractions } from './actions'
import { Scenario, type Script, type Fired } from './scenario/engine'
import { TensionDirector } from './scenario/director'
import { FlagJournal } from './scenario/journal'
import { encode, BeaconClock } from './reveal/morse'
import { clearState } from './reveal/transition'
import { afterEnding, dayNumber, loadVisit, returnMode } from './reveal/visit'
import { createFarField, createFarLight, type RevealWorld } from './reveal/visual'
import { LAMP } from './world/shared'
import { buildWorldSteps, type World } from './world'
import { buildCollision, type Collision } from './world/collision'
import { groundUnder, heightAt, waterDepth } from './world/terrain'
import { EYE_LOW, FLASHLIGHT_REST, FOCUS_FOV, HATCH, FLOOR, DOOR, PORTHOLE, CANOPY } from './world/layout'
import { installIndoorChunks } from './world/indoor'
// Нутро с каталогом предметов - отдельный кусок сборки (`buildInside`): здесь
// только его тип и материалы предметов для прогрева.
import { furnishMaterials } from './world/furnish-materials'
import type { Inside } from './world/inside'
import { postMaterials } from './world/post'
import { zoneAt } from './world/zones'
import { createWeather, type Weather } from './weather'
import { SKY_RADIUS } from './weather/sky'

// --- Рендерер ---------------------------------------------------------------
type QualityName = 'high' | 'medium' | 'low'
const params = new URLSearchParams(location.search)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const device = navigator as Navigator & { deviceMemory?: number }
const phone = matchMedia('(pointer: coarse)').matches
const requestedQuality = params.get('quality')
const autoQuality: QualityName =
  reducedMotion || (device.deviceMemory ?? 4) <= 2 || (navigator.hardwareConcurrency || 4) <= 2
    ? 'low'
    : phone || (device.deviceMemory ?? 4) <= 4 || (navigator.hardwareConcurrency || 4) <= 4 || devicePixelRatio > 1.75
      ? 'medium'
      : 'high'
const qualityName: QualityName =
  requestedQuality === 'high' || requestedQuality === 'medium' || requestedQuality === 'low'
    ? requestedQuality
    : autoQuality
const qualityDpr = { high: 1.75, medium: 1.35, low: 1 }[qualityName]

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(BODY.fov, innerWidth / innerHeight, 0.05, SKY_RADIUS + 20)

// Рендерер, атмосфера и погода заводятся в `boot()` - каждый своей задачей:
// создание контекста видеокарты, конструктор three, цепочка кадра и струи
// дождя вместе с исполнением модуля складывались в одну задачу больше 60 мс.
let renderer!: THREE.WebGLRenderer
let atmosphere!: Atmosphere
let weather!: Weather

/**
 * Масштаб рендера: доля пикселей устройства. Мир меряет кадр и убавляет себе
 * тяжёлое молча (look.md, «Телефон»): сперва масштаб, до половины.
 */
const SCALE_MIN = 0.5
let renderScale = 1
function applyScale(): void {
  renderer.setPixelRatio(Math.min(devicePixelRatio, qualityDpr) * renderScale)
  renderer.setSize(innerWidth, innerHeight)
  atmosphere.composer.setSize(innerWidth, innerHeight)
}

// --- Звук ---------------------------------------------------------------------
const ambient = createAmbient()

// --- Сборка по шагам ---------------------------------------------------------------
/** Отдать поток: `MessageChannel`, а не таймер - у таймера шаг 4 мс и больше. */
const yieldChannel = new MessageChannel()
const yielders: Array<() => void> = []
yieldChannel.port1.onmessage = () => yielders.shift()?.()
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    yielders.push(resolve)
    yieldChannel.port2.postMessage(0)
  })
}

async function buildWorld(): Promise<World> {
  const steps = buildWorldSteps(innerWidth / innerHeight)
  for (;;) {
    const t = performance.now()
    const r = steps.next()
    const spent = performance.now() - t
    if (r.done) return r.value
    mark(r.value)
    console.log(`[vigil] ${r.value}: ${spent.toFixed(0)} мс`)
    await yieldTask()
  }
}

// Отладочный хендл: из консоли доступны камера, игрок, сцена, атмосфера.
// Игрок его не видит - в кадре нет ни панелей, ни счётчиков.
const debug: Record<string, unknown> = { scene, camera, ambient, heightAt, layer, THREE }
Object.assign(window, { vigil: debug })

/**
 * Ниже этой отметки мир кончился. Провалиться можно только сквозь дыру в
 * геометрии; молча оставлять человека падать нельзя, и вернуть его есть куда -
 * на место, где он пришёл в себя.
 */
const FALL_RESET_Y = -20

async function boot(): Promise<void> {
  // Свет нутра правит общие куски шейдеров three: до первой сборки программ.
  installIndoorChunks()
  // Сперва мир: его сборка - чистый JS, видеокарта для неё не нужна. Контекст
  // видеокарты заводится потом, отдельной задачей: первый контекст будит
  // процесс видеокарты, а тот в начале загрузки бывает ещё занят прошлой
  // страницей - синхронный вызов ждал его сотни миллисекунд.
  await yieldTask()
  // Флаги готовности - до всего: дерево коллизий может достроиться раньше,
  // чем дойдёт очередь до экрана входа, и его обработчик их уже спросит.
  let treeReady = false
  let warmDone = false
  let worldUnveiled = false
  const t0 = performance.now()
  const world = await buildWorld()
  if (qualityName !== 'high') world.forest.setDensity(qualityName === 'low' ? 0.5 : 0.75)
  console.log(`[vigil] мир собран за ${(performance.now() - t0).toFixed(0)} мс`)
  mark('мир собран')
  // Слой данных необязателен: без него мир идёт без текстов и событий.
  console.log(`[vigil] слой данных: ${layer.present ? layer.names.join(', ') : 'нет'}`)
  await yieldTask()

  // В дерево идут только коллайдеры поста, стволы и край: земля считается
  // формулой heightAt. Строится оно порциями между кадрами (`world/collision.ts`).
  const collision: Collision = buildCollision(world.solid, () => {
    treeReady = true
    mark('дерево коллизий')
    tryUnveil()
  })

  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })
  await yieldTask()
  renderer = new THREE.WebGLRenderer({ canvas, context: gl ?? undefined, antialias: false, powerPreference: 'high-performance' })
  renderer.setSize(innerWidth, innerHeight)
  document.body.appendChild(renderer.domElement)
  await yieldTask()
  atmosphere = createAtmosphere(scene, camera, renderer, { phone })
  renderScale = atmosphere.renderScale
  applyScale()
  await yieldTask()
  weather = createWeather({
    quality: qualityName,
    onStrike: (s) => atmosphere.sky.setStrike(s.azimuth, s.near ? 15 : 8 + s.power * 5),
    onThunder: (delay, near) => ambient.thunder(delay, near),
  })
  scene.add(weather.group)
  scene.add(world.group)
  Object.assign(debug, { renderer, atmosphere, weather })
  await yieldTask()

  // --- Игрок --------------------------------------------------------------------
  // Взгляд владеет ориентацией камеры, тело - движением.
  const look = new SmoothLook(camera, renderer.domElement, { breath: LOOK.breath })
  look.setYaw(world.yaw, world.pitch)
  // Ввод: клавиши, мышь и палец сводятся в одно намерение.
  const actions = new Actions(layer.present)
  const steps = new StepTrack()
  const script = layer.get<Script>('script')
  const revealData = layer.get<RevealWorld & { returnText?: { arrival?: string; clear?: string } }>('world')
  if (script && revealData?.reveal?.radius && revealData.reveal.length)
    atmosphere.sky.setShape(revealData.reveal.radius, revealData.reveal.length)
  const storage = script ? (() => { try { return localStorage } catch { return null } })() : null
  const visit = loadVisit(storage)
  const visitMode = returnMode(visit.state)
  const epilogue = visitMode === 'epilogue'
  const storyActive = !!script && !epilogue
  const today = dayNumber(revealData?.releaseDate ?? null, revealData?.baseDay ?? 11312)
  const previousDay = dayNumber(revealData?.releaseDate ?? null, revealData?.baseDay ?? 11312, visit.state.endedAt)
  const formatReturn = (value: string | undefined, day: number) => value?.replace('{day}', String(day)) ?? ''
  const journalLines = (): string[] => {
    const lines: string[] = []
    for (const arrival of visit.state.arrivals.slice(-3)) lines.push(formatReturn(revealData?.returnText?.arrival, dayNumber(revealData?.releaseDate ?? null, revealData?.baseDay ?? 11312, arrival)))
    if (epilogue) lines.push(formatReturn(revealData?.returnText?.clear, previousDay))
    return lines.filter(Boolean)
  }
  const flagJournal = new FlagJournal(`vigil:flags:${visit.state.visits + 1}`, storage, storyActive)
  const savedFlags = storyActive && script ? Object.entries(script.flags).filter(([, number]) => flagJournal.has(number)).map(([name]) => name) : []
  if (visitMode === 'resume') {
    const remembered = visit.state.actions
    actions.flashlight = !!remembered.flashlight
    actions.door = !!remembered.door
    // An interrupted recording restarts on the next listen, using the generic route.
    actions.tapePlayed = !!remembered.tapeFinished
    actions.tapeFinished = !!remembered.tapeFinished
    actions.fuel = !!remembered.fuel
    actions.pulls = Number(remembered.pulls) || 0
    actions.crate = Number(remembered.crate) || 0
    actions.wheel = !!remembered.wheel
    actions.tarp = !!remembered.tarp
    actions.automatic = !!remembered.automatic
    actions.lamp = remembered.lamp !== false
  }
  if (savedFlags.includes('flashlight')) actions.flashlight = true
  if (savedFlags.includes('door_open')) actions.door = true
  if (savedFlags.includes('tape_heard')) { actions.tapePlayed = true; actions.tapeFinished = true }
  if (savedFlags.includes('power_back')) { actions.fuel = true; actions.pulls = 3 }
  if (savedFlags.includes('stars_seen')) { actions.crate = 3; actions.wheel = true }
  if (savedFlags.includes('storm_off')) { actions.tarp = true; actions.automatic = true }
  const director = new TensionDirector()
  let scenario!: Scenario
  let interactions: ReturnType<typeof createInteractions> | null = null
  const input = new Input({
    look,
    target: renderer.domElement,
    onAction: () => interactions?.act(),
    onTool: (slot, down) => { if (slot === 1 && down) interactions?.act() },
  })

  // Нутро приходит второй волной, своим деревом коллизий: до него тело знает
  // только поляну и фасад, и входная дверь заперта.
  let inside: Inside | null = null
  let insideTree: Collision | null = null
  let hatchOpen = false
  const trees = (): readonly import('three/examples/jsm/math/Octree.js').Octree[] =>
    insideTree?.ready() ? [collision.octree, insideTree.octree] : [collision.octree]
  const player = new Body({
    camera,
    input,
    support: createSupport({
      trees,
      heightAt,
      ground: groundUnder,
      waterAt: waterDepth,
      // Стойки верха перил на полу у люка стоят, только пока он открыт.
      obstacles: () => {
        const list = world.doors.obstacles()
        if (hatchOpen && inside) for (const p of inside.interior.hatchPosts) list.push({ ax: p.x, az: p.z, bx: p.x, bz: p.z, half: p.half, y0: p.y0, y1: p.y1 })
        // The crate is moved by hand, so it cannot be baked into the static octree.
        if (inside && player.pos.y < -1.5) {
          const crate = inside.furnish.placed.get('crate')?.group
          if (crate) {
            const b = new THREE.Box3().setFromObject(crate)
            for (const [ax, az, bx, bz] of [
              [b.min.x, b.min.z, b.max.x, b.min.z], [b.max.x, b.min.z, b.max.x, b.max.z],
              [b.max.x, b.max.z, b.min.x, b.max.z], [b.min.x, b.max.z, b.min.x, b.min.z],
            ]) list.push({ ax, az, bx, bz, half: 0.025, y0: b.min.y, y1: b.max.y })
          }
        }
        return list
      },
      // Закрытая крышка люка - пол; открытая - проём к лестнице.
      deck: (x, z) => (!hatchOpen && x > HATCH.x0 && x < HATCH.x1 && z > HATCH.z0 && z < HATCH.z1 ? FLOOR.y : null),
    }),
    // Шаг звучит по поверхности под ногой: грязь, бетон отмостки, лужа.
    onStep: (x, z, _dir, _side, running, surface) => {
      ambient.step(surface as Surface, x, z, running)
      if (!actions.door) steps.record(performance.now() / 1000, x, z, surface as Surface, running)
    },
    spawn: world.spawn,
    eye: BODY.eye,
    height: BODY.height,
    walk: BODY.walk,
    run: BODY.run,
    jump: BODY.jump,
    fov: BODY.fov,
    fovRun: BODY.fovRun,
    fovRate: BODY.fovRate,
    stamina: BODY.stamina,
    stepUp: STEP_UP,
    bounds: null, // край поляны держит лес, а не квадрат ядра
  })
  if (visitMode === 'resume' && visit.state.position) {
    player.pos.set(...visit.state.position)
    player.syncCamera()
    look.setYaw(visit.state.yaw, visit.state.pitch)
  }

  /** Перенести тело, не гоняя его туда физикой. */
  function teleport(x: number, y: number, z: number): void {
    player.pos.set(x, y, z)
    player.vel.set(0, 0, 0)
    player.vy = 0
    player.holdY = null
    // Камера переезжает СРАЗУ: иначе кадр между переносом и следующим тиком
    // смотрел бы из покинутой точки, и это читается рывком.
    player.syncCamera()
  }

  // --- Пробуждение --------------------------------------------------------------
  // Вход идёт появлением: мир проступает из темноты сквозь пелену, а по нажатию
  // она отходит, взгляд поднимается с земли к лампе и тело встаёт.
  const awakening: Awakening = createAwakening({
    setVeil: atmosphere.setVeil,
    setLight: atmosphere.setLight,
    look,
    yaw: visitMode === 'resume' ? visit.state.yaw : world.yaw,
    pitch: visitMode === 'resume' ? visit.state.pitch : world.pitch,
    eye: { from: visitMode === 'resume' || epilogue ? player.eye : EYE_LOW, to: player.eye },
    // Цикл тело не зовёт, пока идёт пробуждение, поэтому и камеру по высоте
    // ставим сами: над ступнями, на текущую высоту глаза.
    setEye: (h) => {
      camera.position.y = player.pos.y + h
    },
    setSound: (level) => ambient.setWake(level),
    fov: { from: BODY.fov, to: visitMode === 'resume' || epilogue ? BODY.fov : FOCUS_FOV },
    setFov: (deg) => {
      camera.fov = deg
      camera.updateProjectionMatrix()
    },
    // Пустить в мир можно только по готовому дереву коллизий: без него первый
    // же шаг прошёл бы сквозь стену.
    ready: () => collision.ready() && (visitMode !== 'resume' || !!insideTree?.ready()),
  })

  // --- Управление пальцем -----------------------------------------------------------
  // Создаётся только на тач-устройствах: на десктопе ни кнопок, ни слушателей.
  const touch: Touch | null = touchSupported() ? createTouch(input, look) : null

  /**
   * Кадр в файл. Горячей клавиши нет (игроку она не нужна), зовётся из консоли:
   * `vigil.shot()`. Рисовать надо тут же: буфер не сохраняется между кадрами.
   */
  function shot(): void {
    atmosphere.composer.render()
    renderer.domElement.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `vigil_${Math.floor(performance.now())}.png`
      a.click()
      URL.revokeObjectURL(a.href)
    })
  }

  /** Тот же кадр строкой PNG: для обмера против референса без скачивания. */
  function frameImage(): string {
    atmosphere.composer.render()
    return renderer.domElement.toDataURL('image/png')
  }

  Object.assign(debug, {
    shot,
    frame: frameImage,
    player,
    look,
    input,
    teleport,
    awakening,
    octree: collision.octree,
    collision,
    touch,
    world,
    awake: () => !awakening.holds(),
  })

  // --- Оболочка мира ----------------------------------------------------------
  // Вход, пауза и выход на витрину - общий для всех миров экран (shell.ts).
  // Esc браузер обрабатывает сам: он отпускает курсор, а по этому событию
  // возвращается экран паузы.
  function enterWorld(ev: Event): void {
    // Вход - это конец ожидания: за туманом игрока оставлять нельзя. Дерево
    // коллизий при этом держит пелена самого пробуждения, а не туман меню.
    unveilWorld()
    awakening.enter()

    ambient.start() // до жеста пользователя браузер звук не заводит
    // Чем вошли, тем и играем: спрашиваем само нажатие, палец это был или мышь.
    // Синтетический клик (Enter с клавиатуры) типа указателя не несёт - тогда
    // решает устройство.
    const byFinger =
      touchForced() ||
      (ev && (ev as PointerEvent).pointerType
        ? (ev as PointerEvent).pointerType !== 'mouse'
        : matchMedia('(pointer: coarse)').matches)
    // На таче pointer lock не запрашиваем, а значит и экран паузы закрывать
    // некому - закрываем сами.
    if (touch && byFinger) {
      touch.activate()
      shell.close()
    } else {
      requestMouse()
    }
  }

  // При отказе меню остаётся доступным, и каждое следующее нажатие может
  // повторить запрос. Обрабатываем и Promise, и старый событийный API.
  function mouseDenied(): void {
    if (!document.pointerLockElement && !touch?.active) shell.open()
  }
  function requestMouse(): void {
    try {
      const pending = renderer.domElement.requestPointerLock() as Promise<void> | undefined
      pending?.catch(mouseDenied)
    } catch {
      mouseDenied()
    }
  }
  document.addEventListener('pointerlockerror', mouseDenied)

  const shell = createShell({ onEnter: enterWorld })

  document.addEventListener('pointerlockchange', () => {
    if (touch?.active) return // тач-режим паузой курсора не управляется
    if (document.pointerLockElement) shell.close()
    else shell.open()
  })

  // --- Компиляция и первый кадр ----------------------------------------------------
  // Каждая программа шейдера компилируется синхронно там, где нет параллельной
  // компиляции (программный GL, часть телефонов), и полсотни программ первым
  // кадром - это задача в полсекунды. Поэтому программы собираются ПО ОДНОЙ НА
  // ЗАДАЧУ: объект сцены, потом проходы кадра, потом атлас листвы. Там, где
  // параллельная компиляция есть, это же проходит быстрее и ничем не мешает.
  // Прогрева порциями по кадрам после этого не нужно: `compile` берёт всю
  // сцену, а не только то, что видно из точки входа.
  // `compile` при параллельной компиляции только ставит программу в очередь, а
  // связывает её первая отрисовка - одной длинной задачей на все программы
  // разом. Опрос форм связывает программу здесь же, в своей задаче.
  const sync = (m: THREE.Material): void => {
    const program = (renderer.properties.get(m) as { currentProgram?: { getUniforms(): unknown } }).currentProgram
    program?.getUniforms()
  }
  /** Собрать и связать программы объекта под буфер композера - одна задача. */
  function compileNow(o: THREE.Object3D): number {
    const t = performance.now()
    renderer.setRenderTarget(atmosphere.composer.inputBuffer)
    for (const m of renderer.compile(o, camera, scene)) sync(m)
    renderer.setRenderTarget(null)
    return performance.now() - t
  }
  /**
   * То же без ожидания на главном потоке: программу собирает поток драйвера,
   * а мы опрашиваем её готовность между задачами и связываем уже собранную.
   * Для второй волны: у нутра программы тяжелее, и первый кадр подождёт.
   * Без расширения параллельной сборки программа готова сразу, и это просто
   * `compileNow` (у первой волны так и есть: её программы лёгкие).
   */
  async function compileQuiet(o: THREE.Object3D): Promise<number> {
    renderer.setRenderTarget(atmosphere.composer.inputBuffer)
    const list = [...renderer.compile(o, camera, scene)]
    renderer.setRenderTarget(null)
    const ready = (m: THREE.Material): boolean => {
      const p = (renderer.properties.get(m) as { currentProgram?: { isReady?(): boolean } }).currentProgram
      return p?.isReady?.() ?? true
    }
    while (!list.every(ready)) await new Promise((r) => setTimeout(r, 16))
    const t = performance.now()
    for (const m of list) sync(m)
    return performance.now() - t
  }

  // Материалы поста с нутром. Их программы собираются в прогреве, вместе с
  // уличными, а не второй волной: на тёплом заходе уличные программы берутся
  // из кэша, и первая новая программа после появления мира платит за запуск
  // компилятора - полсекунды одной задачей на программном GL (замер
  // 23.09.2026), какая бы программа это ни была. За туманом входа та же сборка
  // стоит по 20-30 мс на программу.
  const inMats = postMaterials(true)
  const POST_SWAPS: Array<[string, THREE.Material]> = [
    ['post-concrete', inMats.concrete],
    ['post-metal', inMats.metal],
    ['post-glass', inMats.glass],
  ]

  async function compileSpread(): Promise<void> {
    mark('прогрев начат')
    const seen = new Set<string>()
    const objects: THREE.Object3D[] = []
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh & { isInstancedMesh?: boolean; isPoints?: boolean; isLine?: boolean }
      if (!(mesh.isMesh || mesh.isPoints || mesh.isLine) || !o.visible) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const key = mats.map((m) => m.uuid).join() + (mesh.isInstancedMesh ? ':i' : '')
      if (seen.has(key)) return
      seen.add(key)
      objects.push(o)
    })
    let slowest = 0
    let slowestName = ''
    const note = (name: string, t: number): void => {
      const spent = performance.now() - t
      if (spent > slowest) {
        slowest = spent
        slowestName = name
      }
    }
    // Сцена рисуется в буфер композера, а не на экран: у программ для буфера
    // другой ключ (линейный цвет), и собирать их надо под него же.
    const target = atmosphere.composer.inputBuffer
    for (const o of objects) {
      const t = performance.now()
      renderer.setRenderTarget(target)
      for (const m of renderer.compile(o, camera, scene)) sync(m)
      renderer.setRenderTarget(null)
      note(o.name || o.type, t)
      await yieldTask()
    }
    // Программы нутра - на настоящих мешах поста, чтобы ключ был тот же, что
    // у второй волны; меш тут же возвращается к уличному материалу.
    for (const [name, m] of POST_SWAPS) {
      const mesh = world.post.group.getObjectByName(name) as THREE.Mesh | undefined
      if (!mesh) continue
      const was = mesh.material
      mesh.material = m
      const t = performance.now()
      await compileQuiet(mesh)
      note(`${name} с нутром`, t)
      mesh.material = was
      await yieldTask()
    }
    // Три программы предметов нутра - на держателях того же вида, что их
    // пачки: цвет по вершинам (у стекла с прозрачностью, из четырёх
    // компонент), поверхность `surf`, приём тени у всех, кроме свечения.
    // Иначе первая программа предметов - секунда с лишним одной задачей.
    {
      const fm = furnishMaterials(world.lights.glow)
      for (const [kind, m, size] of [
        ['opaque', fm.opaque, 3],
        ['glass', fm.glass, 4],
        ['glow', fm.glow, 3],
      ] as const) {
        const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1)
        const n = geo.getAttribute('position').count
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * size), size))
        geo.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(n * 4), 4))
        const holder = new THREE.Mesh(geo, m)
        holder.receiveShadow = kind !== 'glow'
        const t = performance.now()
        compileNow(holder)
        note(`предметы: ${kind}`, t)
        geo.dispose()
        await yieldTask()
      }
    }
    // Проходы кадра: у каждого свои полноэкранные материалы.
    const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    for (const [m, toScreen] of atmosphere.postMaterials()) {
      const t = performance.now()
      // Держатель - как полноэкранный треугольник postprocessing: без нормалей,
      // иначе ключ программы другой и она соберётся заново первым кадром.
      const plane = new THREE.PlaneGeometry(2, 2)
      plane.deleteAttribute('normal')
      const holder = new THREE.Mesh(plane, m)
      renderer.setRenderTarget(toScreen ? null : target)
      for (const c of renderer.compile(holder, flat)) sync(c)
      renderer.setRenderTarget(null)
      plane.dispose()
      note(m.name || m.type, t)
      await yieldTask()
    }
    // Атлас листвы и прочие карты: загрузка в видеопамять - тоже работа.
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined
      if (m && !Array.isArray(m) && m.map) renderer.initTexture(m.map)
    })
    await yieldTask()
    // Тень лампы: программа глубины собирается при первой отрисовке сцены -
    // пусть это будет своя задача, а не часть первого кадра.
    {
      const t = performance.now()
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      renderer.setRenderTarget(null)
      note('тень', t)
    }
    console.log(`[vigil] программ собрано по одной: ${objects.length}, дольше всех ${slowestName} - ${slowest.toFixed(0)} мс`)
    mark(`прогрев кончен (${objects.length} объектов)`)
  }

  // --- Туман экрана входа -----------------------------------------------------
  // Туман снимает полная сборка мира: собрано дерево коллизий и прогрета сцена.
  // К нему же привязано начало появления: пелена мира отходит тогда, когда
  // расходится туман меню.
  function unveilWorld(): void {
    if (worldUnveiled) return
    worldUnveiled = true
    awakening.reveal()
    ;(window as Window & { __FTE_BOOT__?: { unveil(): void } }).__FTE_BOOT__?.unveil()
  }

  function tryUnveil(): void {
    if (treeReady && warmDone) unveilWorld()
  }

  // Предохранитель: оставить человека за туманом навсегда нельзя ни в каком случае.
  setTimeout(unveilWorld, 15000)

  // --- Ресайз -----------------------------------------------------------------
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    applyScale()
  })

  // --- Вторая волна: нутро --------------------------------------------------
  // Собирается после первого кадра порциями, пока игрок идёт к посту: до
  // двери ему не меньше двух минут (tech.md, «Порядок загрузки»).
  // Код нутра - каталог предметов ядра, опись и комнаты - едет отдельным
  // куском сборки и только теперь: это треть бандла мира, и в критическом
  // пути входа он стоил сотню миллисекунд сети холодному заходу и задачу
  // разбора тёплому (замер 24.09.2026). Service worker кладёт кусок в кэш
  // оболочки вместе с остальными (vite.config.js), так что без сети он есть.
  async function buildInside(): Promise<void> {
    const t0 = performance.now()
    const { buildInsideSteps } = await import('./world/inside')
    // Материалы с нутром (`inMats`, собраны в прогреве): фасад и створки
    // переходят на них - снаружи поверхность та же.
    const steps = buildInsideSteps(inMats, world.lights.glow)
    let built: Inside
    // Самый долгий шаг сборки - в журнал: шаг нутра - задача главного потока
    // во время игры, и рамка у неё та же, 60 мс.
    let stepMax = 0
    let stepName = ''
    for (;;) {
      const t = performance.now()
      const r = steps.next()
      const spent = performance.now() - t
      if (r.done) {
        built = r.value
        break
      }
      if (spent > stepMax) [stepMax, stepName] = [spent, r.value]
      await yieldTask()
    }
    // Include the live display and paper in the same one-material-at-a-time
    // shader warmup as the rest of the interior.
    interactions?.setInside(built)
    interactions?.restore()
    const aperture = built.furnish.placed.get('porthole')
    if (aperture && farField) {
      const glass = aperture.made.glass as THREE.Vector3
      farField.show(aperture.group.localToWorld(glass.clone()))
      await compileQuiet(farField.mesh)
      await yieldTask()
    }
    // Свои программы у нутра - только у предметов: по одной на задачу.
    const seen = new Set<string>()
    const mats: THREE.Object3D[] = []
    built.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined
      if (o.name === 'console-live-screen') return // uses the shared glow material warmed with the outdoor scene
      if (!(o as THREE.Mesh).isMesh || !m || seen.has(m.uuid)) return
      seen.add(m.uuid)
      mats.push(o)
    })
    let slowest = 0
    let slowestName = ''
    const note = (name: string, ms: number): void => {
      if (ms > slowest) [slowest, slowestName] = [ms, name]
    }
    for (const o of mats) {
      note(o.name, await compileQuiet(o))
      await yieldTask()
    }
    // Фасад и створки - на материалы с нутром, по материалу на задачу.
    for (const [name, m] of POST_SWAPS) {
      const mesh = world.post.group.getObjectByName(name) as THREE.Mesh | undefined
      if (!mesh) continue
      mesh.material = m
      note(name, await compileQuiet(mesh))
      await yieldTask()
    }
    world.doors.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.material = mesh.name.startsWith('door-glass') ? inMats.glass : inMats.metal
    })
    built.hatchRail.visible = hatchOpen
    scene.add(built.group)
    inside = built
    insideTree = buildCollision(built.solid, () => {
      const slow = slowestName ? `, дольше всех программа ${slowestName} - ${slowest.toFixed(0)} мс` : ''
      console.log(`[vigil] нутро готово за ${(performance.now() - t0).toFixed(0)} мс, самый долгий шаг ${stepName} - ${stepMax.toFixed(0)} мс${slow}`)
    })
    Object.assign(debug, { inside, insideTree })
  }

  // Keep the vestibule leaf against the partition so both doorways stay clear.
  world.doors.prop('inner', 1)
  world.doors.prop('med', 0.9)
  world.doors.prop('gen', 0.85)
  const doorX = (DOOR.x0 + DOOR.x1) / 2
  let entryUnlocked = false
  let entryReleased = epilogue || savedFlags.includes('door_open')
  let nearEntry = false
  let awayFor = 0
  const DOOR_IDS = ['entry', 'inner', 'med', 'gen', 'cold'] as const
  function doorsTick(dt: number): void {
    const ready = insideTree?.ready() ?? false
    const d = Math.hypot(player.pos.x - doorX, (player.pos.z - -0.15) * 1.2)
    // Start opening before a player leaving the corridor reaches the vestibule.
    // Keeping the leaf at 10% here made it sweep across the player's path.
    if (ready && entryReleased && d < 3.4) {
      if (!entryUnlocked) {
        world.doors.unlock('entry')
        entryUnlocked = true
      }
      world.doors.move('entry', 1, 1.6)
      awayFor = 0
    } else if (world.doors.open('entry') > 0) {
      awayFor += dt
      if (awayFor > 3 && d > 3.6) world.doors.move('entry', 0, 0.8)
    }
    world.doors.update(dt)
    for (const e of world.doors.drain()) ambient.doorEvent(e.id, e.kind, e.speed)
    for (const id of DOOR_IDS) ambient.setDoor(id, world.doors.open(id))
    ambient.setDoor('hatch', hatchOpen ? 1 : 0)
  }

  /** Beam follows only after the explicit pick action. */
  function flashlightTick(dt: number): void {
    const fl = world.flashlight
    fl.follow(dt, camera, player.bobT)
  }

  const lightState = { x: 0, y: 0, z: 0, carried: false, doors: {} as Record<string, number>, mains: true, gain: { F: 1 } }
  function lightsTick(dt: number): void {
    lightState.x = camera.position.x
    lightState.y = camera.position.y
    lightState.z = camera.position.z
    lightState.carried = world.flashlight.carried
    for (const id of DOOR_IDS) lightState.doors[id] = world.doors.open(id)
    lightState.doors.hatch = hatchOpen ? 1 : 0
    world.lights.update(dt, lightState, camera)
    ambient.setLights(world.lights.power)
    // Туман и свет неба идут за зоной игрока: внутри - своя взвесь, внизу - красная.
    const z = world.lights.zone
    atmosphere.setInterior(z === 'out' ? 0 : 1, z === 'I' || z === 'J' ? 1 : 0)
  }

  function openHatch(): void {
      hatchOpen = true
      if (inside) inside.hatchRail.visible = true
      const f = inside?.furnish.moving
      for (const side of ['leaf-left', 'leaf-right']) {
        const leaf = f?.get(`hatch/${side}`)
        if (leaf) leaf.rotation.z = (side === 'leaf-left' ? 1 : -1) * 1.72
      }
  }
  Object.assign(debug, {
    openHatch,
    census: () => world.lights.census(),
    zone: () => zoneAt(camera.position.x, camera.position.y, camera.position.z),
  })

  let previousZone = 'out'
  let lampWasOff = false
  let signalEnabled = epilogue || savedFlags.includes('storm_off')
  let hintFlashUntil = 0
  let hintLampUntil = 0
  const windowFigure = script ? new THREE.Group() : null
  if (windowFigure) {
    const ink = new THREE.MeshBasicMaterial({ color: 0x07120d, fog: false })
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 8, 6), ink)
    head.position.y = 0.12
    const shoulders = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), ink)
    shoulders.scale.y = 0.8
    shoulders.position.y = -0.15
    windowFigure.add(head, shoulders)
    windowFigure.position.set(doorX, (DOOR.window.y0 + DOOR.window.y1) / 2, 0.04)
    windowFigure.visible = false
    scene.add(windowFigure)
  }
  const farField = script ? createFarField(scene, revealData?.reveal?.period ?? 80) : null
  const farLight = script ? createFarLight(scene, revealData?.reveal?.farPost?.elevationDeg, revealData?.reveal?.farPost?.azimuthDeg) : null
  const beacon = revealData?.morse?.call && revealData.morse.answer
    ? new BeaconClock(encode(revealData.morse.call, revealData.morse.farLightUnit ?? 0.35), encode(revealData.morse.answer, revealData.morse.farLightUnit ?? 0.35))
    : null
  let clearElapsed = signalEnabled ? (epilogue ? 40 : visitMode === 'resume' ? Math.max(0, Math.min(40, visit.state.weatherSeconds)) : 40) : -1
  if (signalEnabled) weather.lightning.setEnabled(false)
  if (epilogue || savedFlags.includes('contact')) beacon?.steady()
  else if (signalEnabled) beacon?.setCall()
  if (actions.flashlight) world.flashlight.pick()
  if (savedFlags.includes('blackout') && !savedFlags.includes('power_back')) lightState.mains = false
  if (savedFlags.includes('hatch_open')) openHatch()
  if (epilogue) { actions.door = true; actions.automatic = true; actions.lamp = true }
  const endingCover = script ? document.createElement('div') : null
  if (endingCover) {
    endingCover.style.cssText = 'position:fixed;inset:0;z-index:9;background:#030706;color:#d6d7be;display:grid;place-items:center;font:italic 23px/1.5 Georgia,serif;text-align:center;padding:8vw;opacity:0;pointer-events:none'
    document.body.append(endingCover)
  }
  const writingCard = script ? document.createElement('div') : null
  if (writingCard) {
    writingCard.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) rotate(-1deg);z-index:10;width:min(76vw,480px);min-height:180px;padding:36px;background:#c9ba95;color:#343052;box-shadow:0 18px 70px #000c;font:italic 25px/1.5 Georgia,serif;display:none;pointer-events:none'
    document.body.append(writingCard)
  }
  let ending: { kind: 'a' | 'b'; elapsed: number; line: string; fromYaw: number; fromPitch: number; toYaw: number; toPitch: number; buzzed: boolean } | null = null
  function startEnding(kind: 'a' | 'b'): void {
    if (ending) return
    const chair = inside?.furnish.placed.get('chair-E')?.group.getWorldPosition(new THREE.Vector3())
    const delta = chair?.sub(camera.position)
    ending = { kind, elapsed: 0, line: kind === 'a' ? formatReturn(revealData?.returnText?.arrival, today) : '',
      fromYaw: look.yaw, fromPitch: look.pitch,
      toYaw: delta ? Math.atan2(-delta.x, -delta.z) : look.yaw,
      toPitch: delta ? Math.atan2(delta.y, Math.hypot(delta.x, delta.z)) : look.pitch,
      buzzed: false }
    if (kind === 'a' && writingCard) writingCard.style.display = 'block'
    if (kind === 'a') ambient.eventCue('pen')
    visit.save(afterEnding(visit.state, kind))
  }
  function onScenario(fired: Fired): void {
    for (const [kind, value] of fired.commands) {
      switch (kind) {
        case 'flag': if (typeof value === 'string' && script) flagJournal.put(script.flags[value]); break
        case 'tension': director.set(Number(value)); break
        case 'power': lightState.mains = value !== 'off'; break
        case 'lock': if (value === 'entry:open') entryReleased = true; else if (value === 'hatch:open') openHatch(); break
        case 'insects': if (value === 'cut') ambient.cutInsects(); break
        case 'sound': if (typeof value === 'string') ambient.eventCue(value); break
        case 'weather': if (value === 'clear') { clearElapsed = 0; signalEnabled = true; lampWasOff = false; weather.lightning.setEnabled(false) } break
        case 'farLight':
          if (value === 'call') beacon?.setCall()
          else if (value === 'answer') beacon?.reply()
          else if (value === 'steady') beacon?.steady()
          break
        case 'show': if (windowFigure) windowFigure.visible = true; break
        case 'hide': if (windowFigure) windowFigure.visible = false; break
        case 'hint':
          if (value === 'flashlight') hintFlashUntil = performance.now() + 120
          else if (value === 'lamp') hintLampUntil = performance.now() + 120
          else if (typeof value === 'string') ambient.eventCue(value)
          break
        case 'ending': if (value === 'a' || value === 'b') startEnding(value); break
      }
    }
  }
  scenario = new Scenario(storyActive ? script : undefined, savedFlags, onScenario)
  if (storyActive && script) flagJournal.onRestore((number) => {
    const name = Object.keys(script.flags).find((key) => script.flags[key] === number)
    if (!name) return
    scenario.flags.add(name)
    if (name === 'flashlight') { actions.flashlight = true; world.flashlight.pick(); interactions?.restore() }
    if (name === 'door_open') { actions.door = true; entryReleased = true }
    if (name === 'power_back') { actions.fuel = true; actions.pulls = 3; lightState.mains = true }
    if (name === 'blackout' && !scenario.has('power_back')) lightState.mains = false
    if (name === 'hatch_open') openHatch()
    if (name === 'stars_seen') { actions.crate = 3; actions.wheel = true; interactions?.restore() }
    if (name === 'storm_off') { actions.tarp = true; actions.automatic = true; clearElapsed = 40; signalEnabled = true; weather.lightning.setEnabled(false); beacon?.setCall() }
    if (name === 'contact') beacon?.steady()
  })
  if (storyActive && visitMode !== 'resume') scenario.emit('start')
  if (storyActive && visitMode === 'resume') {
    if (savedFlags.includes('contact') && !savedFlags.includes('ending_b')) scenario.emit('farLight:answer:end')
    else if (savedFlags.includes('power_back') && !savedFlags.includes('hatch_open')) scenario.emit('power:on')
    else if (savedFlags.includes('tape_heard') && !savedFlags.includes('blackout')) scenario.emit('tape:end')
  }
  Object.assign(debug, { scenario, flagJournal, director, visit, farField, farLight, beacon })

  // --- Цикл -------------------------------------------------------------------
  const timer = new THREE.Timer()
  const ear = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1 }
  const earDir = new THREE.Vector3()
  const PAUSE_FRAME_MS = 1000 / 30
  let nextPauseFrameAt = 0

  // Сторож кадра: если кадр стабильно тяжелее бюджета, масштаб рендера
  // убавляется ступенями. Назад не прибавляем: мигание качества хуже его нехватки.
  const FRAME_BUDGET = 1 / 45
  let slowFor = 0
  let lastSaveAt = performance.now()
  function rememberVisit(): void {
    if (!storyActive || ending || awakening.holds()) return
    visit.save({ ...visit.state, position: player.pos.toArray() as [number, number, number], yaw: look.yaw, pitch: look.pitch, weatherSeconds: Math.max(0, Math.min(40, clearElapsed)),
      actions: { flashlight: actions.flashlight, door: actions.door, tapePlayed: actions.tapePlayed, tapeFinished: actions.tapeFinished,
        fuel: actions.fuel, pulls: actions.pulls, crate: actions.crate, wheel: actions.wheel, tarp: actions.tarp,
        automatic: actions.automatic, lamp: actions.lamp } })
    lastSaveAt = performance.now()
  }
  addEventListener('pagehide', rememberVisit)
  document.addEventListener('visibilitychange', () => { if (document.hidden) rememberVisit() })

  function frame(frameAt: number): void {
    // Пока туман экрана входа сплошной, мира за ним не видно - рисовать его
    // незачем. Фон паузы живёт в 30 кадрах/с, пробуждение и игра - с частотой
    // экрана.
    if (document.hidden || !document.body.classList.contains('unveiled')) {
      nextPauseFrameAt = 0
      return
    }
    if (document.body.classList.contains('paused') && !awakening.holds()) {
      if (frameAt + 0.5 < nextPauseFrameAt) return
      nextPauseFrameAt =
        frameAt - nextPauseFrameAt >= PAUSE_FRAME_MS ? frameAt + PAUSE_FRAME_MS : nextPauseFrameAt + PAUSE_FRAME_MS
    } else {
      nextPauseFrameAt = 0
    }
    timer.update()

    // потолок на dt: после свёрнутой вкладки не должно телепортировать сквозь стены
    const raw = timer.getDelta()
    const dt = Math.min(raw, 0.05)
    // Пока идёт пробуждение, игрок не управляет ничем: камерой ведёт awaken.ts,
    // а физику звать нельзя вовсе - дерево коллизий может быть ещё не собрано.
    // Тело трогается со следующего кадра после конца появления: первый кадр
    // после него - ровно тот, что поставило появление (он и есть эталонный).
    const wasAwake = !awakening.holds()
    awakening.update(dt)
    const awake = !awakening.holds()
    const playing = awake && !document.body.classList.contains('paused') && !ending
    if (wasAwake && !ending) {
      // Взгляд - ДО физики: идти игрок должен по свежему направлению.
      look.update(dt, player)
      input.update(dt)
      interactions?.update(dt, player.bobT, Math.abs(input.intent.move.x) + Math.abs(input.intent.move.y) > 0.2)
      touch?.setAction(!!interactions?.target)
      if (!actions.pose) player.update(dt)
      if (player.pos.y < FALL_RESET_Y) teleport(world.spawn.x, world.spawn.y, world.spawn.z)
      flashlightTick(dt)
    }
    if (storyActive && playing) {
      const zone = zoneAt(player.pos.x, player.pos.y + player.eye, player.pos.z)
      if (zone !== previousZone) {
        previousZone = zone
        scenario.emit(`zone:${zone}`)
        rememberVisit()
      }
      if (zone === 'B' && world.doors.open('inner') > 0.5) {
        const windowPoint = new THREE.Vector3(doorX, (DOOR.window.y0 + DOOR.window.y1) / 2, 0)
        const toWindow = windowPoint.sub(camera.position).normalize()
        const facing = camera.getWorldDirection(earDir).dot(toWindow)
        if (facing > Math.cos(Math.PI / 18)) scenario.emit('look:entry-window')
      }
      if (windowFigure?.visible) {
        const toWindow = windowFigure.position.clone().sub(camera.position).normalize()
        if (zone !== 'B' || camera.getWorldDirection(earDir).dot(toWindow) < Math.cos(Math.PI / 18)) windowFigure.visible = false
      }
      const d = Math.hypot(player.pos.x - doorX, (player.pos.z + 0.15) * 1.2)
      if (d < 2.4 && !nearEntry) { nearEntry = true; scenario.emit('near:entry') }
      if (d >= 3) nearEntry = false
      scenario.update(dt)
      const level = director.update(dt)
      atmosphere.setTension(level)
      ambient.setTension(level)
      world.flashlight.setPower(frameAt < hintFlashUntil ? 0.5 : 1 - director.flicker * (Math.sin(frameAt * 0.031) > 0.996 ? 0.75 : 0))
      const lampLevel = actions.lamp ? (frameAt < hintLampUntil ? 0.45 : 1) : 0
      LAMP.power.value = lampLevel
      world.lamp.intensity = lampLevel * 145
    }
    doorsTick(dt)
    lightState.gain.F = ending?.kind === 'a' && ending.elapsed >= 4.8 && ending.elapsed < 5.2 ? 0.55 : 1
    lightsTick(dt)
    if (clearElapsed >= 0) {
      if (playing) clearElapsed += dt
      const clear = clearState(clearElapsed)
      weather.rain.setIntensity(clear.rain)
      ambient.setRain(clear.rain)
      atmosphere.setDensity(clear.fog)
      atmosphere.sky.setClear(clear.sky)
    }
    farField?.update(playing ? dt : 0)
    if (signalEnabled && beacon && farLight) {
      const ray = farLight.direction
      const roofT = (CANOPY.y + CANOPY.thick - camera.position.y) / ray.y
      const roofX = camera.position.x + ray.x * roofT
      const roofZ = camera.position.z + ray.z * roofT
      const blockedByCanopy = roofT > 0 && roofX >= CANOPY.x0 && roofX <= CANOPY.x1 && roofZ >= CANOPY.z0 && roofZ <= CANOPY.z1
      const observed = world.lights.zone === 'out' && !blockedByCanopy && farLight.observed(camera)
      const pulse = beacon.update(playing ? dt : 0, playing ? observed : true)
      farLight.update(camera, pulse.light, clearElapsed < 0 ? 0 : clearState(clearElapsed).sky)
      if (pulse.completed && storyActive) scenario.emit('farLight:answer:end')
    }
    weather.update(dt, camera, awake)
    atmosphere.update(dt)
    if (ending && endingCover) {
      ending.elapsed += dt
      const fadeAt = ending.kind === 'a' ? 6 : 1
      const fade = Math.max(0, Math.min(1, (ending.elapsed - fadeAt) / 5))
      endingCover.style.opacity = String(fade)
      if (ending.kind === 'a' && writingCard) {
        writingCard.textContent = ending.line.slice(0, Math.floor(ending.elapsed * 7))
        if (ending.elapsed >= fadeAt) writingCard.style.display = 'none'
        if (ending.elapsed >= 6) {
          const k = Math.max(0, Math.min(1, (ending.elapsed - 6) / 4))
          const yawDelta = Math.atan2(Math.sin(ending.toYaw - ending.fromYaw), Math.cos(ending.toYaw - ending.fromYaw))
          look.setYaw(ending.fromYaw + yawDelta * k, ending.fromPitch + (ending.toPitch - ending.fromPitch) * k)
        }
        if (ending.elapsed >= 11.1 && !ending.buzzed) { ending.buzzed = true; ambient.eventCue('buzzer') }
      }
      const soundLevel = ending.kind === 'a'
        ? ending.elapsed < 11.8 ? 1 - fade * 0.9 : Math.max(0, 0.1 * (13 - ending.elapsed) / 1.2)
        : 1 - fade
      ambient.setWake(soundLevel)
      if (ending.elapsed >= (ending.kind === 'a' ? 13 : 8)) location.reload()
    }
    // Слух - там, где глаз, и смотрит туда же.
    camera.getWorldDirection(earDir)
    ear.x = camera.position.x
    ear.y = camera.position.y
    ear.z = camera.position.z
    ear.fx = earDir.x
    ear.fy = earDir.y
    ear.fz = earDir.z
    const toGlass = new THREE.Vector3(PORTHOLE.x, -3.24, PORTHOLE.z).sub(camera.position)
    ambient.setFarField(actions.wheel && toGlass.length() < 3.2 && earDir.dot(toGlass.normalize()) > Math.cos(Math.PI / 9) ? 1 : 0)
    ambient.update(dt, ear)
    if (storyActive && awake && !ending && frameAt - lastSaveAt >= 2000) rememberVisit()
    atmosphere.composer.render()
    // Снимок первого кадра после появления - по просьбе из консоли или обмера.
    if (awake && !wasAwake && debug.captureFirst) {
      debug.firstFrame = renderer.domElement.toDataURL('image/png')
      debug.captureFirst = false
    }

    if (awake && !document.body.classList.contains('paused')) {
      slowFor = raw > FRAME_BUDGET && raw < 0.2 ? slowFor + raw : Math.max(0, slowFor - raw * 0.5)
      if (slowFor > 3 && renderScale > SCALE_MIN) {
        renderScale = Math.max(SCALE_MIN, renderScale - 0.1)
        applyScale()
        slowFor = 0
      }
    }
  }

  // Первый кадр - после того как собраны программы: тогда он дешёвый.
  await compileSpread()
  await yieldTask()
  atmosphere.update(0)
  weather.update(0, camera, false)
  atmosphere.composer.render()
  mark('первый кадр')
  // Экран входа уже открыт - мир лишь забирает его себе. Туман меню при этом
  // не снимается: его снимет `tryUnveil`, когда сойдётся всё.
  shell.ready()
  renderer.setAnimationLoop(frame)
  keepOffline() // следующий приход в мир - без сети (offline.ts)
  warmDone = true
  tryUnveil()
  // Вторая волна - после первого кадра и открытого экрана входа.
  await yieldTask()
  const { createInteractions } = await import('./actions')
  interactions = createInteractions({
    scene, camera, world, ambient, layer, actions, steps,
    allow: (target) => epilogue ? target === 'journal' || target === 'flashlight' : scenario.allows(target),
    journalLines,
    journalDay: today,
    onEvent(event) {
      if (storyActive) {
        const key = event.kind === 'pick' || event.kind === 'use' || event.kind === 'open' ? `${event.kind}:${event.id}`
          : event.kind === 'read:open' ? `read:${event.id}` : event.kind
        scenario.emit(key)
      }
      if (event.kind === 'lamp:toggle') {
        const on = !!event.value
        LAMP.power.value = on ? 1 : 0
        world.lamp.intensity = on ? 145 : 0
        world.post.tube.visible = on
        world.post.glow.visible = on
        if (storyActive) {
          if (!on && signalEnabled) lampWasOff = true
          else if (lampWasOff) { lampWasOff = false; scenario.emit('lamp:cycle') }
        }
      }
    },
  })
  if (inside) interactions.setInside(inside)
  Object.assign(debug, { actions, steps, interactions })
  buildInside().catch((e: unknown) => console.warn('[vigil] нутро не собралось:', e))
}

void boot()
