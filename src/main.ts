/**
 * main.ts — точка входа: рендерер, мир, игрок, цикл.
 *
 * Управление целиком из общего ядра миров (`world-core/core`): тело, взгляд,
 * ввод. Мир отдаёт телу только свою форму (`support.ts`) и свои числа
 * (`player.ts`). Оболочка входа, появление, прогрев и цикл устроены так же,
 * как в Winter Tower, и там же объяснено почему (docs/games.md).
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
  'мир собран': 'лес',
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
import { createAtmosphere } from './atmosphere'
import { createAmbient } from './ambient'
import { createAwakening } from './awaken'
import { createSupport, STEP_UP } from './support'
import { createTouch, touchForced, touchSupported, type Touch } from './touch'
import { BODY, LOOK } from './player'
import { layer } from './layer'
import { buildWorld } from './world'
import { buildCollision } from './world/collision'
import { heightAt } from './world/terrain'
import { EYE_LOW } from './world/layout'

// --- Рендерер ---------------------------------------------------------------
type QualityName = 'high' | 'medium' | 'low'
const params = new URLSearchParams(location.search)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const device = navigator as Navigator & { deviceMemory?: number }
const requestedQuality = params.get('quality')
const autoQuality: QualityName =
  reducedMotion || (device.deviceMemory ?? 4) <= 2 || (navigator.hardwareConcurrency || 4) <= 2
    ? 'low'
    : matchMedia('(pointer: coarse)').matches ||
        (device.deviceMemory ?? 4) <= 4 ||
        (navigator.hardwareConcurrency || 4) <= 4 ||
        devicePixelRatio > 1.75
      ? 'medium'
      : 'high'
const qualityName: QualityName =
  requestedQuality === 'high' || requestedQuality === 'medium' || requestedQuality === 'low'
    ? requestedQuality
    : autoQuality
const qualityDpr = { high: 1.75, medium: 1.35, low: 1 }[qualityName]

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, qualityDpr))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(BODY.fov, innerWidth / innerHeight, 0.05, 400)
const atmosphere = createAtmosphere(scene, camera, renderer)

// --- Мир --------------------------------------------------------------------
const t0 = performance.now()
const world = buildWorld()
scene.add(world.group)
const tWorld = performance.now() - t0

// В дерево идут только постройки: земля считается формулой heightAt. Строится
// оно порциями между кадрами (`world/collision.ts`), а не разом.
let treeReady = false
const collision = buildCollision(world.solid, () => {
  treeReady = true
  mark('дерево коллизий')
  tryUnveil()
})
const octree = collision.octree
mark('мир собран')
console.log(`[vigil] мир собран за ${tWorld.toFixed(0)} мс`)
// Слой данных необязателен: без него мир идёт без текстов и событий.
console.log(`[vigil] слой данных: ${layer.present ? layer.names.join(', ') : 'нет'}`)

// --- Игрок ------------------------------------------------------------------
// Взгляд владеет ориентацией камеры, тело — движением.
const look = new SmoothLook(camera, renderer.domElement, { breath: LOOK.breath })
look.setYaw(world.yaw, world.pitch)

// Ввод: клавиши, мышь и палец сводятся в одно намерение. Рука-действие
// появится вместе с вещами, которые можно тронуть.
const input = new Input({ look, target: renderer.domElement })

/**
 * Ниже этой отметки мир кончился. Провалиться можно только сквозь дыру в
 * геометрии; молча оставлять человека падать нельзя, и вернуть его есть куда -
 * на место, где он пришёл в себя.
 */
const FALL_RESET_Y = -20

const ambient = createAmbient()

const player = new Body({
  camera,
  input,
  support: createSupport({ octree, heightAt }),
  spawn: world.spawn,
  eye: BODY.eye,
  height: BODY.height,
  walk: BODY.walk,
  run: BODY.run,
  jump: BODY.jump,
  fov: BODY.fov,
  fovRun: BODY.fovRun,
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
// Вход в мир идёт появлением: мир проступает из темноты сквозь пелену, а по
// нажатию она отходит, взгляд поднимается с земли к лампе и тело встаёт.
// Модуль владеет на это время туманом, светом, камерой и высотой глаза.
const awakening = createAwakening({
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
  // Пустить в мир можно только по готовому дереву коллизий: без него первый
  // же шаг прошёл бы сквозь стену.
  ready: () => collision.ready(),
})

// --- Управление пальцем -------------------------------------------------------
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

// Отладочный хендл: из консоли доступны камера, игрок, сцена, атмосфера.
// Игрок его не видит - в кадре нет ни панелей, ни счётчиков.
Object.assign(window, {
  vigil: {
    shot,
    scene,
    camera,
    player,
    look,
    input,
    teleport,
    awakening,
    atmosphere,
    ambient,
    octree,
    collision,
    renderer,
    touch,
    heightAt,
    world,
    layer,
    THREE,
  },
})

// --- Оболочка мира ----------------------------------------------------------
// Вход, пауза и выход на витрину — общий для всех миров экран (shell.ts).
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

// --- Прогрев и первый кадр -----------------------------------------------------
// Первый кадр - обычный, с живым culling'ом: компилируется только то, что
// видно из точки входа, и после него мир можно показывать. Остальная сцена
// прогревается ПОРЦИЯМИ ПО КАДРАМ с бюджетом на порцию: кнопка на экране
// входа должна отвечать и в это время (тот же приём, что `warmSceneSpread`
// в Snowfall).
const WARM_BUDGET_MS = 12

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function warmSpread(): Promise<void> {
  const pend: THREE.Object3D[] = []
  scene.traverse((o) => {
    const drawable = o as THREE.Object3D & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean }
    if ((drawable.isMesh || drawable.isPoints || drawable.isLine) && o.frustumCulled) pend.push(o)
  })
  mark('прогрев начат')
  let size = 4
  for (let i = 0; i < pend.length; ) {
    const part = pend.slice(i, i + size)
    i += part.length
    for (const o of part) o.frustumCulled = false
    const t = performance.now()
    atmosphere.composer.render()
    // Дождаться, пока нарисованное действительно нарисуется: без этого цена
    // порции врёт в меньшую сторону, а отложенный счёт приходит потом разом.
    renderer.getContext().finish()
    const spent = performance.now() - t
    for (const o of part) o.frustumCulled = true
    size = spent > WARM_BUDGET_MS ? Math.max(1, size >> 1) : Math.min(32, size + 2)
    await nextFrame()
  }
  mark(`прогрев кончен (${pend.length} объектов)`)
}

let warmed = false

function warmUp(): void {
  if (warmed) return
  warmed = true
  requestAnimationFrame(() => {
    // Пелену пробуждение уже выставило, а туман собирается из неё в `update`.
    atmosphere.update(0)
    atmosphere.composer.render()
    mark('первый кадр')
    // Экран входа уже открыт — мир лишь забирает его себе. Туман меню при
    // этом не снимается: его снимет `tryUnveil`, когда сойдётся всё.
    shell.ready()
    startLoop()
    keepOffline() // следующий приход в мир — без сети (offline.ts)
    void warmSpread().then(() => {
      warmDone = true
      tryUnveil()
    })
  })
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

warmUp()

// --- Ресайз -----------------------------------------------------------------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  atmosphere.composer.setSize(innerWidth, innerHeight)
})

// --- Цикл -------------------------------------------------------------------
const timer = new THREE.Timer()
let loopStarted = false
const PAUSE_FRAME_MS = 1000 / 30
let nextPauseFrameAt = 0

function startLoop(): void {
  if (loopStarted) return
  loopStarted = true
  renderer.setAnimationLoop(frame)
}

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
  const dt = Math.min(timer.getDelta(), 0.05)
  // Пока идёт пробуждение, игрок не управляет ничем: камерой ведёт awaken.ts,
  // а физику звать нельзя вовсе — дерево коллизий может быть ещё не собрано.
  awakening.update(dt)
  if (!awakening.holds()) {
    // Взгляд — ДО физики: идти игрок должен по свежему направлению.
    look.update(dt, player)
    player.update(dt)
    if (player.pos.y < FALL_RESET_Y) teleport(world.spawn.x, world.spawn.y, world.spawn.z)
  }
  atmosphere.update(dt)
  ambient.update(dt)
  atmosphere.composer.render()
}
