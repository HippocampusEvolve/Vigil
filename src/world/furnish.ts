/**
 * world/furnish.ts — предметы нутра: как предмет из каталога встаёт в
 * комнату, чем он покрашен и во что сливается.
 *
 * Предмет попадает в мир только через каталог ядра `world-core/props`
 * (docs/architecture.md, «Каталог»): мир не собирает мебель у себя, он её
 * расставляет. Что где стоит - `placement.ts`; здесь механика.
 *
 * Простая идея, как у типографского набора: каталог отливает литеры (группу
 * мешей с материалами по ролям), мир ставит их в строку и красит одной
 * краской. Каждая роль каталога (`paint`, `wood`, `glass`...) подменяется
 * меткой с видом из палитры мира (`Look`), и дальше всё неподвижное в комнате
 * сливается в три меша: непрозрачное, стекло и свечение. Полсотни предметов
 * по десятку деталей - это пятьсот вызовов отрисовки, а после слияния - три
 * на комнату.
 *
 * По шагам:
 *   1. предмет собирается каталогом с материалами-метками (`mats`): роль, для
 *      которой в палитре нет вида, - ошибка сборки, а не молчаливая подмена;
 *   2. встаёт на место: в мировые координаты, на другой предмет (`on`) или
 *      своей точкой (`pin` - трубка, лампочка, тыл) в заданную точку;
 *   3. подвижные детали (`userData.moving`) остаются группами на своих осях -
 *      их двигают этапы рук и сценария, - но детали каждой группы сливаются по
 *      тем же трём краскам: группа - это один-три вызова, а не десяток;
 *   4. неподвижное уходит в слияние своей комнаты; твёрдое - в рамку для
 *      тела; предмет целиком - в тело для проверки наложений.
 *
 * Краски - одна программа на всё непрозрачное: вид поверхности едет атрибутом
 * вершины (`surf`: шероховатость, металл, порода, светильник), а не отдельным
 * материалом на каждую породу. Три программы предметов - общие одиночки
 * (`furnishMaterials`, свой модуль `furnish-materials.ts`): их можно собрать
 * заранее, до того как нутро появится, не везя для этого каталог.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { turn } from 'world-core/props'
import { box, merge } from './geom'
import { FIXTURES, ROOMS, zoneAt, type FixtureId, type RoomId } from './zones'
import { PALETTE, PLACEMENT } from './placement'
import { furnishMaterials } from './furnish-materials'

export { furnishMaterials, type FurnishMaterials } from './furnish-materials'

/** Породы поверхности: номер уезжает в шейдер атрибутом. */
export const KIND = {
  paint: 0,
  steel: 1,
  rust: 2,
  wood: 3,
  cloth: 4,
  rubber: 5,
  enamel: 6,
  paper: 7,
  plastic: 8,
  brass: 9,
  soil: 10,
  leaf: 11,
  fruit: 12,
  photo: 13,
  /** Погасшая трубка: люминофор серый, концы в тёмных ожогах (`span` - её длина). */
  burnt: 14,
} as const
export type Kind = keyof typeof KIND

/** Шероховатость и металл по породе: отправные, цвет - у роли. */
const SURF: Record<Kind, [number, number]> = {
  paint: [0.62, 0.15],
  steel: [0.42, 0.75],
  rust: [0.85, 0.25],
  wood: [0.72, 0],
  cloth: [0.95, 0],
  rubber: [0.8, 0],
  enamel: [0.28, 0],
  paper: [0.9, 0],
  plastic: [0.5, 0],
  brass: [0.34, 0.85],
  soil: [0.98, 0],
  leaf: [0.7, 0],
  fruit: [0.35, 0],
  photo: [0.55, 0],
  burnt: [0.3, 0],
}

/** Что светится: трубка, лампа, экран, шкала, огонёк, абажур. */
export type GlowRole = 'tube' | 'bulb' | 'screen' | 'dial' | 'led' | 'shade'
export const GLOW_ROLES: GlowRole[] = ['tube', 'bulb', 'screen', 'dial', 'led', 'shade']

/**
 * Краска роли: порода и цвет, или стекло, или свечение - цвет, сила и
 * светильник, за силой которого оно идёт. `span` у породы - длина детали вдоль
 * её развёртки (погасшей трубке - где концы).
 */
export type Look =
  | { kind: Kind; color: number; span?: number }
  | { glass: true; color: number; opacity?: number }
  | { glow: GlowRole; color: number; strength: number; fixture?: FixtureId }

/** Краски по ролям (или по именам деталей). */
export type Palette = Record<string, Look>

/** Метка роли: материал-пустышка, по которому слияние узнаёт краску детали. */
type Marker = THREE.MeshBasicMaterial & { userData: { look: Look; role: string; prop: string } }

/**
 * Материалы по ролям для предмета каталога. Каждая роль обязана быть в
 * словаре `looks`; чужая роль - ошибка, с именем предмета и роли.
 */
export function mats(prop: string, looks: Palette): Record<string, THREE.Material> {
  const cache = new Map<string, Marker>()
  return new Proxy({} as Record<string, THREE.Material>, {
    get(_t, role) {
      if (typeof role !== 'string') return undefined
      const look = looks[role]
      if (!look) throw new Error(`furnish: у предмета «${prop}» нет краски для роли «${role}»`)
      let m = cache.get(role)
      if (!m) {
        m = new THREE.MeshBasicMaterial() as Marker
        m.userData = { look, role, prop }
        cache.set(role, m)
      }
      return m
    },
    has(_t, role) {
      return typeof role === 'string' && role in looks
    },
  })
}

// --- Расстановка: что описывает мир -------------------------------------------------

/** Что вернул каталог: группа и, если нужно, точка, которой предмет встаёт на место. */
export type Made = { group: THREE.Group; point?: THREE.Vector3 }

type Vec3 = [number, number, number]

/** Одна расстановка: предмет из каталога, где стоит, повёрнут ли, твёрд ли. */
export type Item = {
  /** Имя в реестре: по нему этапы рук и сценария находят предмет. */
  name: string
  /** Собрать предмет из каталога с этими материалами-метками. */
  make: (m: Record<string, THREE.Material>) => Made
  /**
   * Где стоит начало предмета (или его точка `point`, см. `pin`). С `on` -
   * в координатах того предмета, и тогда можно функцией от того, что вернул
   * для него каталог (высота столешницы, место под магнитофон).
   */
  at: Vec3 | ((under: Record<string, any>) => Vec3)
  /** Поворот вокруг Y, рад; с `on` - от поворота того предмета. */
  yaw?: number
  /** Стоит на другом предмете: его имя, он расставлен раньше. */
  on?: string
  /**
   * В `at` встаёт не начало, а точка `point` предмета: трубка, лампочка, тыл.
   * `xz` - только в плане, высота - у начала.
   */
  pin?: 'xz' | 'xyz'
  /** Твёрдый для тела: рамкой по габаритам. */
  solid?: boolean
  /** Краски поверх палитры мира, по ролям. */
  looks?: Palette
  /** Своя краска отдельной детали, по имени меша (одна чашка из пяти мытая). */
  parts?: Palette
  /** Подвижные детали этот этап не двигает: слить их с неподвижным. */
  still?: boolean
  /** Whole item stays separate so an action can move or hide it. */
  loose?: boolean
  /** Положение подвижных частей при сборке, рад: по имени части (`turn` ядра). */
  pose?: Record<string, number>
}

export type Placed = {
  /** Имя в реестре: по нему этапы рук находят предмет. */
  name: string
  group: THREE.Group
  /** В какой комнате стоит. */
  room: RoomId
  /** Что вернул каталог: точки предмета (экран, рычаг, место под записку). */
  made: Made & Record<string, unknown>
}

export type Furnish = {
  group: THREE.Group
  /** Все расставленные предметы по именам: их подвижные детали живут здесь. */
  placed: Map<string, Placed>
  /** Подвижные детали: `предмет/деталь`. */
  moving: Map<string, THREE.Object3D>
  /** Твёрдое: рамки предметов, до которых достаёт тело. */
  colliders: THREE.BufferGeometry
  /** Тела для проверки наложений: предмет целиком, в мировых координатах. */
  bodies: Array<{ name: string; geometry: THREE.BufferGeometry }>
}

/** Выше этой отметки над полом предмет телу не мешает. */
const REACH = 1.8

/**
 * Бюджет шага сборки, мс. Шаг кончается после предмета, перебравшего
 * бюджет, то есть шаг - это бюджет плюс один предмет. Шаг - задача главного
 * потока во время игры, и рамка у неё входная, 60 мс. Самый тяжёлый предмет
 * (вешалка с плащами) на первом прогоне в браузере - до 30 мс; при бюджете
 * 12 мс шаги доходили до 56 мс (замер 24.09.2026) и под нагрузкой машины
 * выходили за рамку.
 */
const STEP_MS = 4

/** Непрозрачное, стекло, свечение: три меша на комнату и на подвижную часть. */
type Kind3 = 'opaque' | 'glass' | 'glow'
const classOf = (look: Look): Kind3 => ('glass' in look ? 'glass' : 'glow' in look ? 'glow' : 'opaque')

/** Стекло без своей прозрачности. */
const GLASS_OPACITY = 0.55

// --- Геометрия -----------------------------------------------------------------------

type Piece = { geo: THREE.BufferGeometry; look: Look }

/**
 * Треугольники меша по краскам. У меша с группами материалов (катушка:
 * пластмасса и лента, кружка: эмаль и кант) - кусок на группу.
 */
function piecesOf(item: Item, mesh: THREE.Mesh): Piece[] {
  const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
  const own = item.parts?.[mesh.name]
  const lookOf = (m: THREE.Material | undefined): Look => {
    if (own) return own
    const look = (m as Marker | undefined)?.userData?.look
    if (!look) throw new Error(`furnish: у детали «${item.name}/${mesh.name}» материал не из словаря мира`)
    return look
  }
  if (!Array.isArray(mesh.material)) return [{ geo: src, look: lookOf(mesh.material) }]
  const list = mesh.material
  if (!src.groups.length) return [{ geo: src, look: lookOf(list[0]) }]
  const out: Piece[] = []
  for (const grp of src.groups) {
    const part = new THREE.BufferGeometry()
    for (const name of ['position', 'normal', 'uv']) {
      const a = src.getAttribute(name) as THREE.BufferAttribute | undefined
      if (!a) continue
      const n = a.itemSize
      const count = Math.min(grp.count, a.count - grp.start)
      part.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(grp.start * n, (grp.start + count) * n), n))
    }
    out.push({ geo: part, look: lookOf(list[grp.materialIndex ?? 0]) })
  }
  return out
}

/** Кусок в нужных координатах с атрибутами краски. */
function prepare(piece: Piece, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const g = piece.geo.clone()
  const look = piece.look
  g.applyMatrix4(matrix)
  g.clearGroups()
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name)
  if (!g.getAttribute('normal')) g.computeVertexNormals()
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
  const n = g.getAttribute('position').count
  const c = new THREE.Color(look.color)
  let r = 0.9
  let m = 0
  let kind = 0
  let extra = -1
  let alpha = 1
  if ('kind' in look) {
    ;[r, m] = SURF[look.kind]
    kind = KIND[look.kind]
    if (look.span !== undefined) extra = look.span
  } else if ('glow' in look) {
    c.multiplyScalar(look.strength)
    extra = look.fixture ? FIXTURES.findIndex((f) => f.id === look.fixture) : -1
  } else {
    r = 0.12
    alpha = look.opacity ?? GLASS_OPACITY
  }
  // У стекла цвет с прозрачностью: у каждого стекла своя, программа одна.
  const size = 'glass' in look ? 4 : 3
  const col = new Float32Array(n * size)
  const surf = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    col[i * size] = c.r
    col[i * size + 1] = c.g
    col[i * size + 2] = c.b
    if (size === 4) col[i * size + 3] = alpha
    surf[i * 4] = r
    surf[i * 4 + 1] = m
    surf[i * 4 + 2] = kind
    surf[i * 4 + 3] = extra
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, size))
  g.setAttribute('surf', new THREE.BufferAttribute(surf, 4))
  return g
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null
  const g = mergeGeometries(list, false)
  if (!g) throw new Error('furnish: детали с разными атрибутами')
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return g
}

/** Тело предмета для проверки: только положение, всё одним куском. */
function bodyOf(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null
  const bare = list.map((g) => {
    const b = new THREE.BufferGeometry()
    b.setAttribute('position', g.getAttribute('position'))
    return b
  })
  return mergeAll(bare)
}

// --- Сборка ----------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0)

export function* furnishSteps(
  _materials: { concrete: THREE.Material; metal: THREE.Material; glass: THREE.Material },
  items: Item[] = PLACEMENT,
  power?: { value: number[] },
  palette: Palette = PALETTE,
): Generator<void, Furnish, void> {
  const group = new THREE.Group()
  group.name = 'furnish'
  const placed = new Map<string, Placed>()
  const moving = new Map<string, THREE.Object3D>()
  const batches = new Map<RoomId, Record<Kind3, THREE.BufferGeometry[]>>()
  const solid: THREE.BufferGeometry[] = []
  const bodies: Array<{ name: string; geometry: THREE.BufferGeometry }> = []
  const shared = furnishMaterials(power)
  const matOf: Record<Kind3, THREE.Material> = { opaque: shared.opaque, glass: shared.glass, glow: shared.glow }

  let spent = performance.now()
  for (const item of items) {
    if (placed.has(item.name)) throw new Error(`furnish: имя «${item.name}» уже занято`)
    const made = item.make(mats(item.name, { ...palette, ...item.looks })) as Placed['made']
    const g = made.group
    g.name = item.name

    // Место: своё, или на другом предмете в его координатах.
    let pos: THREE.Vector3
    let yaw = item.yaw ?? 0
    if (item.on) {
      const under = placed.get(item.on)
      if (!under) throw new Error(`furnish: «${item.name}» стоит на «${item.on}», а его ещё нет`)
      const local = typeof item.at === 'function' ? item.at(under.made) : item.at
      under.group.updateMatrixWorld(true)
      pos = under.group.localToWorld(new THREE.Vector3(...local))
      yaw += under.group.rotation.y
    } else {
      if (typeof item.at === 'function') throw new Error(`furnish: у «${item.name}» место функцией, но не на чем стоять`)
      pos = new THREE.Vector3(...item.at)
    }
    if (item.pin) {
      if (!made.point) throw new Error(`furnish: «${item.name}» встаёт точкой, а каталог её не вернул`)
      const p = made.point.clone().applyAxisAngle(UP, yaw)
      pos.x -= p.x
      pos.z -= p.z
      if (item.pin === 'xyz') pos.y -= p.y
    }
    g.position.copy(pos)
    g.rotation.set(0, yaw, 0)

    // Подвижные части: положение при сборке, до всякого счёта.
    if (item.pose) {
      const named = new Map<string, THREE.Object3D>()
      g.traverse((o) => {
        if (o.userData.moving) named.set(o.userData.moving as string, o)
      })
      for (const [name, v] of Object.entries(item.pose)) {
        const part = named.get(name)
        if (!part) throw new Error(`furnish: у «${item.name}» нет подвижной части «${name}»`)
        turn(part, v)
      }
    }
    g.updateMatrixWorld(true)

    const bb = new THREE.Box3().setFromObject(g)
    const center = bb.getCenter(new THREE.Vector3())
    const zone = zoneAt(center.x, center.y, center.z)
    if (zone === 'out') throw new Error(`furnish: «${item.name}» стоит снаружи (${center.toArray().map((v) => v.toFixed(2)).join(', ')})`)
    const room = zone
    placed.set(item.name, { name: item.name, group: g, room, made })
    let batch = batches.get(room)
    if (!batch) batches.set(room, (batch = { opaque: [], glass: [], glow: [] }))

    // Рамка - до слияния, пока все детали на месте.
    if (item.solid && !item.loose && bb.min.y < ROOMS[room].floor + REACH) solid.push(box(bb.min.x, bb.max.x, bb.min.y, bb.max.y, bb.min.z, bb.max.z))

    // Детали: каждая - к ближней подвижной группе или в слияние комнаты.
    const meshes: THREE.Mesh[] = []
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
    })
    const whole: THREE.BufferGeometry[] = []
    const roots = new Map<THREE.Object3D, Record<Kind3, THREE.BufferGeometry[]>>()
    const inverse = new THREE.Matrix4()
    const rel = new THREE.Matrix4()
    for (const mesh of meshes) {
      let root: THREE.Object3D | null = item.loose ? g : null
      if (!item.still) for (let q = mesh.parent; q && q !== g; q = q.parent) if (q.userData.moving) {
        root = q
        break
      }
      for (const piece of piecesOf(item, mesh)) {
        whole.push(prepare(piece, mesh.matrixWorld))
        const k = classOf(piece.look)
        if (root) {
          let own = roots.get(root)
          if (!own) roots.set(root, (own = { opaque: [], glass: [], glow: [] }))
          inverse.copy(root.matrixWorld).invert()
          rel.multiplyMatrices(inverse, mesh.matrixWorld)
          own[k].push(prepare(piece, rel))
        } else batch[k].push(whole[whole.length - 1])
      }
    }
    for (const mesh of meshes) mesh.parent?.remove(mesh)

    // Подвижная группа: её детали - один-три меша на её осях.
    for (const [root, own] of roots) {
      const name = item.loose ? 'whole' : root.userData.moving as string
      const key = moving.has(`${item.name}/${name}`) ? `${item.name}/${root.name}` : `${item.name}/${name}`
      moving.set(key, root)
      for (const k of ['opaque', 'glass', 'glow'] as Kind3[]) {
        const geo = mergeAll(own[k])
        if (!geo) continue
        const mesh = new THREE.Mesh(geo, matOf[k])
        mesh.name = `${root.name}-${k}`
        mesh.castShadow = k === 'opaque' && (geo.boundingSphere?.radius ?? 0) > 0.12
        mesh.receiveShadow = k !== 'glow'
        root.add(mesh)
      }
    }
    if (roots.size) group.add(g)

    // Тело для проверки наложений - предмет целиком: детали внутри предмета
    // проверяет каталог, мир спрашивает, не вошёл ли предмет в стену или в соседа.
    const body = bodyOf(whole)
    if (body) bodies.push({ name: item.name, geometry: body })
    if (performance.now() - spent > STEP_MS) {
      yield
      spent = performance.now()
    }
  }

  for (const [room, b] of batches) {
    for (const k of ['opaque', 'glass', 'glow'] as Kind3[]) {
      const geo = mergeAll(b[k])
      if (!geo) continue
      const mesh = new THREE.Mesh(geo, matOf[k])
      mesh.name = `props${k === 'opaque' ? '' : `-${k}`}-${room}`
      mesh.castShadow = k === 'opaque'
      mesh.receiveShadow = k !== 'glow'
      group.add(mesh)
    }
    yield
  }

  return { group, placed, moving, colliders: merge(solid), bodies }
}
