/**
 * world/forest-plan.ts — где что растёт: план леса числами, без геометрии.
 *
 * План отделён от сборки намеренно. Сборка рисует листву на канве и живёт
 * только в браузере, а план - обычные числа, и его берут трое: сборка леса,
 * опора тела (стволы и край поляны - твёрдые) и проверка геометрии на Node.
 * Всё по семени: один и тот же мир при каждой сборке.
 *
 * Простая идея, как у садовника с планом участка. Сперва проводится граница:
 * край поляны рваный, а с запада вместо леса - промоина ручья. Потом
 * расставляются главные деревья - исполины и стволы среднего яруса, пальмы у
 * места пролога. Остальное сажается пятнами: подлесок и папоротник гуще у
 * края, трава у стен и на крышах, лианы свисают с навеса, карниза и веток.
 */

import { rng } from './geom'
import { heightAt, postDistance, streamCenter, trailAt, waterDepth } from './terrain'
import {
  BLOCK,
  CANOPY,
  CLEARING,
  EDGE_RAG,
  HANGAR,
  PLINTH,
  STREAM,
  THICK_CABLES,
  WAKE_POINT,
} from './layout'

export type TrunkKind = 'giant' | 'mid' | 'palm'
export type Trunk = {
  kind: TrunkKind
  x: number
  z: number
  /** Подошва ствола: чуть ниже земли, чтобы не висеть над волной грязи. */
  y: number
  height: number
  /** Радиус у земли, м. */
  radius: number
  /** Наклон верхушки в плане, м. */
  leanX: number
  leanZ: number
  /** Досковидные корни исполина: сколько крыльев. */
  fins: number
  seed: number
}

export type PlantKind = 'broad' | 'split' | 'fern' | 'grass'
export type Plant = { kind: PlantKind; x: number; y: number; z: number; scale: number; yaw: number }

/** Свисающее: лиана или борода мха. Точка подвеса, длина вниз. */
export type Hang = { kind: 'vine' | 'moss'; x: number; y: number; z: number; length: number; yaw: number }

/** Клок кроны: карточка в вышине. */
export type Crown = { x: number; y: number; z: number; size: number; yaw: number }

/** Ветвь дерева у пролога: по ней висят бороды мха. */
export type Branch = { from: [number, number, number]; to: [number, number, number]; radius: number }

export type ForestPlan = {
  /** Край, по которому можно ходить: замкнутый многоугольник в плане. */
  boundary: Array<[number, number]>
  trunks: Trunk[]
  plants: Plant[]
  hangs: Hang[]
  crowns: Crown[]
  branch: Branch
}

/** Шаг узлов границы вдоль края, м. */
const EDGE_STEP = 2

/** Сколько чего. Числа - из look.md, раздел «Лес». */
const COUNT = { mid: 52, broad: 220, split: 70, fern: 460, grass: 1500, vines: 45, moss: 56 } as const

/** Гладкий шум вдоль края: край рвётся волнами, а не зубьями. */
function edgeNoise(s: number, seed: number): number {
  return (
    0.5 +
    0.3 * Math.sin(s * 0.37 + seed) +
    0.15 * Math.sin(s * 0.91 + seed * 2.3) +
    0.05 * Math.sin(s * 2.1 + seed * 0.7)
  )
}

/** Отступ края внутрь, м: от `EDGE_RAG.min - 1.5` до `EDGE_RAG.max - 1.5`. */
function inset(s: number, seed: number): number {
  return EDGE_RAG.min - 1.5 + (EDGE_RAG.max - EDGE_RAG.min) * edgeNoise(s, seed)
}

/** Где кончается ходьба с запада: верх восточного борта промоины. */
export function streamBank(z: number): number {
  return streamCenter(z) + STREAM.water / 2 + 1.35
}

function buildBoundary(): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  const { minX, maxX, minZ, maxZ } = CLEARING
  // Север: слева направо.
  for (let x = streamBank(minZ + 2); x < maxX; x += EDGE_STEP) pts.push([x, minZ + inset(x, 1.3) * 0.7])
  // Восток: сверху вниз.
  for (let z = minZ; z < maxZ; z += EDGE_STEP) pts.push([maxX - inset(z, 4.1), z])
  // Юг: справа налево.
  for (let x = maxX; x > streamBank(maxZ); x -= EDGE_STEP) pts.push([x, maxZ - inset(x, 7.7)])
  // Запад: по борту промоины, снизу вверх.
  for (let z = maxZ - 1; z > minZ + 1; z -= EDGE_STEP) pts.push([streamBank(z), z])
  return pts
}

/** Точка внутри многоугольника: чётность пересечений луча. */
export function insidePolygon(poly: ReadonlyArray<readonly [number, number]>, x: number, z: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]
    const [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** Расстояние до ломаной границы: снаружи и внутри одинаково положительное. */
function edgeDistance(poly: ReadonlyArray<readonly [number, number]>, x: number, z: number): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]
    const [bx, bz] = poly[i]
    const dx = bx - ax
    const dz = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)))
  }
  return best
}

/** Расстояние до ближайшего толстого кабеля: вдоль них игрок идёт к свету. */
function cableDistance(x: number, z: number): number {
  let best = Infinity
  for (const cable of THICK_CABLES) {
    for (let i = 1; i < cable.length; i++) {
      const [ax, az] = cable[i - 1]
      const [bx, bz] = cable[i]
      const dx = bx - ax
      const dz = bz - az
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
      best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)))
    }
  }
  return best
}

/** Высота внешней поверхности свода над точкой плана; вне свода - `null`. */
export function vaultTop(x: number, z: number): number | null {
  if (x < HANGAR.x0 || x > HANGAR.x1) return null
  const half = (HANGAR.z1 - HANGAR.z0) / 2
  const u = (z - (HANGAR.z0 + HANGAR.z1) / 2) / half
  if (Math.abs(u) >= 1) return null
  return HANGAR.wall + (HANGAR.ridge - HANGAR.wall) * Math.sqrt(1 - u * u)
}

/** Исполины: место выбрано под кадр и под край, размеры - по семени. */
const GIANTS: ReadonlyArray<readonly [number, number]> = [
  [-18, -18.5],
  [-6.5, -20],
  [5, -17.5],
  [16, -19],
  [-37, 3],
  [-38, 19],
  [-36, -12],
  [27, 9],
  [26.5, -8],
  [28, 23],
  [7, 37],
  [-15, 36.5],
  [-27, 35],
  // Дерево у пролога: его низкая ветвь с бородами мха нависает над местом,
  // где лежало тело, и обрамляет левый верх первого кадра.
  [-10.4, 28.6],
]

/** Пальмы: у места пролога и по правому нижнему краю первого кадра. */
const PALMS: ReadonlyArray<readonly [number, number]> = [
  [-1.2, 20.3],
  [-7.8, 29.3],
  [2.2, 27.6],
  [-13.5, 22.8],
  [14.5, 20.5],
  [18, 12.5],
  [-20.5, 26],
  [-14.5, -12.8],
]

/** План целиком одним куском: для проверок на Node. */
export function planForest(): ForestPlan {
  const steps = planForestSteps()
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/**
 * План по шагам: генератор отдаёт управление между посадками, чтобы в
 * браузере ни один кусок не держал поток дольше рамки самой долгой задачи.
 */
export function* planForestSteps(): Generator<void, ForestPlan, void> {
  const r = rng(20260923)
  const boundary = buildBoundary()
  const inside = (x: number, z: number) => insidePolygon(boundary, x, z)
  const trunks: Trunk[] = []
  const plants: Plant[] = []
  const hangs: Hang[] = []
  const crowns: Crown[] = []

  /** Можно ли здесь что-то посадить на земле поляны. */
  const clearOf = (x: number, z: number, room: number): boolean => {
    if (postDistance(x, z) < room) return false
    if (Math.hypot(x - WAKE_POINT.x, z - WAKE_POINT.z) < 1.6) return false
    if (x > PLINTH.x0 - 0.6 && x < CANOPY.x1 + 0.3 && z > -0.2 && z < CANOPY.z1 + 0.6) return false
    if (waterDepth(x, z) > 0) return false
    return true
  }
  const onGround = (x: number, z: number): number => heightAt(x, z)

  // --- Стволы ------------------------------------------------------------------
  GIANTS.forEach(([x, z], i) => {
    trunks.push({
      kind: 'giant',
      x,
      z,
      y: onGround(x, z) - 0.3,
      height: 35 + r() * 10,
      radius: 0.6 + r() * 0.4,
      leanX: (r() - 0.5) * 2,
      leanZ: (r() - 0.5) * 2,
      fins: 3 + Math.floor(r() * 3),
      seed: i + 1,
    })
  })
  // Средний ярус: полоса леса за краем поляны, гуще за постом - там их видно.
  let tries = 0
  while (trunks.filter((t) => t.kind === 'mid').length < COUNT.mid && tries++ < 5000) {
    const behind = r() < 0.4
    const x = behind ? -30 + r() * 52 : CLEARING.minX - 14 + r() * (CLEARING.maxX - CLEARING.minX + 28)
    const z = behind ? CLEARING.minZ - 16 + r() * 16 : CLEARING.minZ - 14 + r() * (CLEARING.maxZ - CLEARING.minZ + 28)
    const d = edgeDistance(boundary, x, z)
    const isIn = inside(x, z)
    if (isIn && (d > 2.5 || !clearOf(x, z, 4))) continue
    if (!isIn && d > 16) continue
    if (Math.abs(x - streamCenter(z)) < 2.4 && z > STREAM.z0 - 4) continue
    if (trunks.some((t) => Math.hypot(t.x - x, t.z - z) < (t.kind === 'giant' ? 3.5 : 1.6))) continue
    trunks.push({
      kind: 'mid',
      x,
      z,
      y: onGround(x, z) - 0.2,
      height: 12 + r() * 8,
      radius: 0.1 + r() * 0.15,
      leanX: (r() - 0.5) * 1.2,
      leanZ: (r() - 0.5) * 1.2,
      fins: 0,
      seed: 100 + trunks.length,
    })
  }
  PALMS.forEach(([x, z], i) => {
    trunks.push({
      kind: 'palm',
      x,
      z,
      y: onGround(x, z) - 0.15,
      height: 6 + r() * 6,
      radius: 0.14 + r() * 0.06,
      leanX: (r() - 0.5) * 2.2,
      leanZ: (r() - 0.5) * 2.2,
      fins: 0,
      seed: 200 + i,
    })
  })

  // Кроны: карточки в вышине. Исполин - шапка у вершины и ярусы ниже, средний
  // ярус - несколько клоков у макушки. Почти всё это съест туман, но силуэт
  // на фоне неба держат именно они.
  for (const t of trunks) {
    if (t.kind === 'palm') continue
    const n = t.kind === 'giant' ? 9 : 3
    for (let i = 0; i < n; i++) {
      const k = t.kind === 'giant' ? 0.55 + r() * 0.45 : 0.75 + r() * 0.25
      const a = r() * Math.PI * 2
      const spread = t.kind === 'giant' ? 3 + r() * 5 : 0.8 + r() * 1.5
      crowns.push({
        x: t.x + t.leanX * k + Math.cos(a) * spread,
        y: t.y + t.height * k,
        z: t.z + t.leanZ * k + Math.sin(a) * spread,
        size: t.kind === 'giant' ? 7 + r() * 5 : 2.5 + r() * 2,
        yaw: r() * Math.PI,
      })
    }
  }

  // --- Ветвь у пролога и бороды мха -----------------------------------------
  const oak = trunks[GIANTS.length - 1]
  const branch: Branch = {
    from: [oak.x + 0.3, oak.y + 5.4, oak.z - 0.5],
    to: [-5.6, 5.6, 20.2],
    radius: 0.22,
  }
  for (let i = 0; i < COUNT.moss; i++) {
    const t = 0.2 + 0.8 * (i / COUNT.moss) + (r() - 0.5) * 0.04
    const sag = Math.sin(Math.PI * t) * 0.6
    hangs.push({
      kind: 'moss',
      x: branch.from[0] + (branch.to[0] - branch.from[0]) * t + (r() - 0.5) * 0.3,
      y: branch.from[1] + (branch.to[1] - branch.from[1]) * t - sag - branch.radius * 0.6,
      z: branch.from[2] + (branch.to[2] - branch.from[2]) * t + (r() - 0.5) * 0.3,
      length: 0.8 + r() * 2.6,
      yaw: r() * Math.PI,
    })
  }

  // --- Лианы: с навеса, с карниза ангара, с ветвей -------------------------------
  for (let i = 0; i < 12; i++) {
    // Над дверью не висят: вход виден и проходим.
    let x = CANOPY.x0 + 0.1 + r() * (CANOPY.x1 - CANOPY.x0 - 0.2)
    if (x > 1.4 && x < 3.6) x = r() < 0.5 ? 0.6 + r() * 0.7 : 3.7 + r() * 3.2
    hangs.push({ kind: 'vine', x, y: CANOPY.y + 0.02, z: CANOPY.z1 - 0.05, length: 0.5 + r() * 2.0, yaw: r() * 0.4 })
  }
  for (let i = 0; i < 12; i++) {
    const x = HANGAR.x0 + 0.5 + r() * (HANGAR.x1 - HANGAR.x0 - 1)
    hangs.push({ kind: 'vine', x, y: HANGAR.wall + 0.25, z: HANGAR.z1 + 0.12, length: 0.5 + r() * 1.5, yaw: r() * 0.4 })
  }
  const hosts = trunks.filter((t) => t.kind !== 'palm')
  for (let i = hangs.filter((h) => h.kind === 'vine').length; i < COUNT.vines; i++) {
    const t = hosts[Math.floor(r() * hosts.length)]
    const a = r() * Math.PI * 2
    const d = t.radius + 0.5 + r() * 3
    const y = t.y + Math.min(t.height * (0.35 + r() * 0.4), 16)
    hangs.push({ kind: 'vine', x: t.x + Math.cos(a) * d, y, z: t.z + Math.sin(a) * d, length: 3 + r() * 9, yaw: r() * Math.PI })
  }

  yield

  // --- Подлесок и папоротник -------------------------------------------------------
  /** Пятно у края: чуть внутри поляны или в лесу за ним. */
  const edgeSpot = (): [number, number] | null => {
    const x = CLEARING.minX - 8 + r() * (CLEARING.maxX - CLEARING.minX + 16)
    const z = CLEARING.minZ - 8 + r() * (CLEARING.maxZ - CLEARING.minZ + 16)
    const d = edgeDistance(boundary, x, z)
    const isIn = inside(x, z)
    if (isIn ? d > 2 : d > 7) return null
    if (Math.abs(x - streamCenter(z)) < 1.2 && z > STREAM.z0 - 4) return null
    return [x, z]
  }
  const sow = (kind: PlantKind, count: number, where: () => [number, number] | null, scale: [number, number]) => {
    let n = 0
    let guard = 0
    while (n < count && guard++ < count * 40) {
      const spot = where()
      if (!spot) continue
      const [x, z] = spot
      if (inside(x, z) && !clearOf(x, z, kind === 'grass' ? 0.05 : 0.6)) continue
      if (kind !== 'grass' && inside(x, z) && cableDistance(x, z) < 1.1) continue
      if (kind !== 'grass' && trailAt(x, z) > 0.2) continue
      plants.push({ kind, x, y: onGround(x, z), z, scale: scale[0] + r() * (scale[1] - scale[0]), yaw: r() * Math.PI * 2 })
      n++
    }
  }

  // Широкий лист: край, углы поста, пятна на поляне.
  sow('broad', Math.round(COUNT.broad * 0.7), edgeSpot, [0.7, 1.4])
  sow('broad', Math.round(COUNT.broad * 0.3), () => {
    const x = CLEARING.minX + r() * (CLEARING.maxX - CLEARING.minX)
    const z = CLEARING.minZ + r() * (CLEARING.maxZ - CLEARING.minZ)
    return inside(x, z) && edgeDistance(boundary, x, z) < 9 ? [x, z] : null
  }, [0.6, 1.1])
  yield
  sow('split', COUNT.split, edgeSpot, [0.7, 1.2])
  // Крупный подлесок слева от места пролога: тёмный край первого кадра.
  sow('broad', 26, () => [-15 + r() * 8, 11 + r() * 10], [1.3, 1.9])
  yield
  // Папоротник: край и передний план слева от места пролога.
  sow('fern', Math.round(COUNT.fern * 0.5), edgeSpot, [0.6, 1.2])
  sow('fern', Math.round(COUNT.fern * 0.3), () => [-13 + r() * 9, 16 + r() * 15], [0.6, 1.1])
  sow('fern', Math.round(COUNT.fern * 0.2), () => [CLEARING.minX + r() * 54, CLEARING.minZ + r() * 48], [0.5, 0.9])

  yield

  // --- Трава: у стен, в трещинах отмостки, на крышах, по поляне ---------------------
  sow('grass', Math.round(COUNT.grass * 0.35), () => {
    const side = r()
    const off = 0.1 + r() * 1.1
    if (side < 0.45) return [HANGAR.x0 + r() * (BLOCK.x1 - HANGAR.x0), HANGAR.z1 + off]
    if (side < 0.75) return [HANGAR.x0 + r() * (BLOCK.x1 - HANGAR.x0), HANGAR.z0 - off]
    if (side < 0.88) return [HANGAR.x0 - off, HANGAR.z0 + r() * (HANGAR.z1 - HANGAR.z0)]
    return [BLOCK.x1 + off, BLOCK.z0 + r() * (BLOCK.z1 - BLOCK.z0)]
  }, [0.5, 1.0])
  sow('grass', Math.round(COUNT.grass * 0.35), () => [CLEARING.minX + r() * 54, CLEARING.minZ + r() * 48], [0.4, 0.9])
  // Перед отмосткой трава гуще: здесь не ходят, и её держит свет лампы.
  sow('grass', 160, () => [PLINTH.x0 - 0.8 + r() * (CANOPY.x1 - PLINTH.x0 + 1.2), PLINTH.z1 + 0.15 + r() * 3.2], [0.5, 1.0])
  // В трещинах отмостки и на крышах - без проверки земли: там своя высота.
  for (let i = 0; i < 150; i++) {
    const crack = Math.floor(r() * 4)
    const x = PLINTH.x0 + 0.15 + ((crack + r() * 0.8) / 4) * (PLINTH.x1 - PLINTH.x0 - 0.3)
    const z = PLINTH.z0 + 0.2 + r() * (PLINTH.z1 - PLINTH.z0 - 0.3)
    if (x > 1.6 && x < 3.4 && z < 1.6) continue
    plants.push({ kind: 'grass', x, y: PLINTH.top, z, scale: 0.35 + r() * 0.4, yaw: r() * Math.PI * 2 })
  }
  for (let i = 0; i < 260; i++) {
    const x = HANGAR.x0 + 0.4 + r() * (HANGAR.x1 - HANGAR.x0 - 0.8)
    const z = HANGAR.z0 + 0.3 + r() * (HANGAR.z1 - HANGAR.z0 - 0.6)
    const y = vaultTop(x, z)
    if (y === null) continue
    plants.push({ kind: 'grass', x, y: y - 0.03, z, scale: 0.45 + r() * 0.5, yaw: r() * Math.PI * 2 })
  }
  for (let i = 0; i < 90; i++) {
    const onCanopy = r() < 0.5
    const x = onCanopy ? CANOPY.x0 + 0.2 + r() * (CANOPY.x1 - CANOPY.x0 - 0.4) : BLOCK.x0 + 0.4 + r() * 5.2
    const z = onCanopy ? CANOPY.z0 + 0.2 + r() * (CANOPY.z1 - CANOPY.z0 - 0.4) : BLOCK.z0 + 0.4 + r() * 7.2
    const y = onCanopy ? CANOPY.y + CANOPY.thick : BLOCK.height
    plants.push({ kind: 'grass', x, y: y - 0.02, z, scale: 0.5 + r() * 0.5, yaw: r() * Math.PI * 2 })
  }

  return { boundary, trunks, plants, hangs, crowns, branch }
}

/** Стволы, в которые можно упереться: внутри границы или у самого края. */
export function solidTrunks(plan: ForestPlan): Trunk[] {
  return plan.trunks.filter((t) => insidePolygon(plan.boundary, t.x, t.z) || edgeDistance(plan.boundary, t.x, t.z) < t.radius + 1)
}
