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
import { createSupport, STEP_UP } from './support'
import { createTouch, touchForced, touchSupported, type Touch } from './touch'
import { BODY, LOOK } from './player'
import { layer } from './layer'
import { buildWorldSteps, type World } from './world'
import { buildCollision, type Collision } from './world/collision'
import { heightAt } from './world/terrain'
import { EYE_LOW, FOCUS_FOV } from './world/layout'
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
  // Контекст видеокарты - отдельной задачей: первый контекст в браузере
  // будит процесс видеокарты, и это десятки миллисекунд сами по себе.
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
  Object.assign(debug, { renderer, atmosphere, weather })
  await yieldTask()

  const t0 = performance.now()
  const world = await buildWorld()
  scene.add(world.group)
  if (qualityName !== 'high') world.forest.setDensity(qualityName === 'low' ? 0.5 : 0.75)
  console.log(`[vigil] мир собран за ${(performance.now() - t0).toFixed(0)} мс`)
  mark('мир собран')
  // Слой данных необязателен: без него мир идёт без текстов и событий.
  console.log(`[vigil] слой данных: ${layer.present ? layer.names.join(', ') : 'нет'}`)
  await yieldTask()

  // В дерево идут только постройки, стволы и край: земля считается формулой
  // heightAt. Строится оно порциями между кадрами (`world/collision.ts`).
  let treeReady = false
  const collision: Collision = buildCollision(world.solid, () => {
    treeReady = true
    mark('дерево коллизий')
    tryUnveil()
  })

  // --- Игрок --------------------------------------------------------------------
  // Взгляд владеет ориентацией камеры, тело - движением.
  const look = new SmoothLook(camera, renderer.domElement, { breath: LOOK.breath })
  look.setYaw(world.yaw, world.pitch)
  // Ввод: клавиши, мышь и палец сводятся в одно намерение.
  const input = new Input({ look, target: renderer.domElement })

  const player = new Body({
    camera,
    input,
    support: createSupport({ octree: collision.octree, heightAt }),
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
    yaw: world.yaw,
    pitch: world.pitch,
    eye: { from: EYE_LOW, to: player.eye },
    // Цикл тело не зовёт, пока идёт пробуждение, поэтому и камеру по высоте
    // ставим сами: над ступнями, на текущую высоту глаза.
    setEye: (h) => {
      camera.position.y = player.pos.y + h
    },
    setSound: (level) => ambient.setWake(level),
    fov: { from: BODY.fov, to: FOCUS_FOV },
    setFov: (deg) => {
      camera.fov = deg
      camera.updateProjectionMatrix()
    },
    // Пустить в мир можно только по готовому дереву коллизий: без него первый
    // же шаг прошёл бы сквозь стену.
    ready: () => collision.ready(),
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
  async function compileSpread(): Promise<void> {
    mark('прогрев начат')
    const sync = (m: THREE.Material): void => {
      const program = (renderer.properties.get(m) as { currentProgram?: { getUniforms(): unknown } }).currentProgram
      program?.getUniforms()
    }
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
  let warmDone = false
  let worldUnveiled = false

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

  // --- Цикл -------------------------------------------------------------------
  const timer = new THREE.Timer()
  const PAUSE_FRAME_MS = 1000 / 30
  let nextPauseFrameAt = 0

  // Сторож кадра: если кадр стабильно тяжелее бюджета, масштаб рендера
  // убавляется ступенями. Назад не прибавляем: мигание качества хуже его нехватки.
  const FRAME_BUDGET = 1 / 45
  let slowFor = 0

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
    if (wasAwake) {
      // Взгляд - ДО физики: идти игрок должен по свежему направлению.
      look.update(dt, player)
      player.update(dt)
      if (player.pos.y < FALL_RESET_Y) teleport(world.spawn.x, world.spawn.y, world.spawn.z)
    }
    weather.update(dt, camera, awake)
    atmosphere.update(dt)
    ambient.update(dt)
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
}

void boot()
