/**
 * world/placement.ts — обстановка нутра: какой предмет каталога где стоит и
 * чем покрашен.
 *
 * Механика - в `furnish.ts`; здесь только список, как опись комнат: зона за
 * зоной, предмет за предметом (look.md, «Нутро»). Координаты - от граней
 * комнат (`ROOMS`), проёмов, окон и точек раскладки (`layout.ts`, `zones.ts`);
 * свои числа (где стоит стол, шаг шкафчиков) - константами ниже, одним местом.
 *
 * Как встаёт предмет:
 *   - у стены - тылом (`back` + `pin: 'xz'`): каталог знает свою рамку, мир
 *     называет стену и отступ;
 *   - на стене - началом на грани стены: настенные предметы каталога сами
 *     отступают от своей опоры;
 *   - светильник - своей трубкой или лампочкой ровно в точку светильника из
 *     `FIXTURES` (`pin: 'xyz'`): свет и то, что светится, - одно место;
 *   - на другом предмете (`on`) - в его координатах, по высоте, которую
 *     вернул каталог (столешница, полка, крышка).
 *
 * Краска мира - одна палитра (`PALETTE`) на все роли словаря каталога:
 * советская станция, всё казённое, крашеное, облезлое, сырое. Краска в
 * середине по яркости (0.15-0.5 линейной, look.md, «Эталон кадра»): темноту
 * делает экспозиция, а не чёрные материалы. Светящиеся роли в палитре -
 * погасшие; горят они только у светильника (`lit`) и идут за его силой.
 */

import * as THREE from 'three'
import {
  bandage,
  bench,
  boots,
  bucket,
  bunk,
  cableTray,
  cageLamp,
  chair,
  chairStack,
  climateConsole,
  coat,
  coatBoard,
  cot,
  coveredMirror,
  crate,
  cupShelf,
  desk,
  deskLamp,
  extinguisher,
  foldedCot,
  generator,
  hatchLid,
  jar,
  jerrycan,
  listeningConsole,
  locker,
  medCabinet,
  microscope,
  mug,
  nightLamp,
  nightstand,
  openBook,
  panelBox,
  pen,
  photoFrame,
  plantRack,
  pod,
  porthole,
  pump,
  radio,
  rolledMattress,
  scales,
  scissors,
  shelfWithBooks,
  sideboard,
  sugarBowl,
  table,
  tagBox,
  tapeRecorder,
  tarp,
  tomatoPlant,
  tubeFixture,
  wallClock,
  washbasin,
  workbench,
} from 'world-core/props'
import { BLOCK_CEILING, CABLE_SLEEVE, COLD_DOOR, DOORWAY, FLOOR, GENERATOR, HANGAR_WALLS, HANGAR_WINDOWS, HATCH, LOWER, OPENINGS, PORTHOLE } from './layout'
import { fixture, ROOMS, SOURCES, vaultY, type FixtureId, type RoomId } from './zones'
import { PORTHOLE_HOLE } from './interior'
import type { GlowRole, Item, Look, Made, Palette } from './furnish'

type Vec3 = [number, number, number]
const half = (a: number, b: number) => (a + b) / 2

// --- Свои числа обстановки ----------------------------------------------------------

/** Мебель у стены: тыл на сантиметр от грани. */
const OFF = 0.01

/**
 * Светильник без подвесов: от точки крепления до оси трубки (`tubeFixture`,
 * `rods = 0`), и лампа в сетке - от низа шнура до середины колбы (`cageLamp`).
 * Числа каталога; тест проверяет, что светильник ими упирается в потолок.
 */
const TUBE_DROP = 0.08
const CAGE_DROP = 0.1
/** Длина светящейся части трубки 1.25 м без патронов (`tubeLength`). */
const TUBE_LIGHT = 1.19

/** Тамбур: вешалка посередине западной стены, сапоги под плащами, скамья у фасада. */
const COAT_BOARD = { y: 1.75, hooks: 5, w: 1.3 }
const BOOTS_Z = [-1.0, -1.32, -1.64, -1.96]
const BENCH_X = 1.2
const MIRROR_Y = 1.45

/** Коридор: огнетушитель между дверями медпункта и генераторной, щит в торце. */
const EXTINGUISHER = { x: 3.4, y: 1.05 }
const PANEL_Y = 1.45
/**
 * Лоток от щита в торце вдоль северной стены под потолком. Длина и отступ -
 * от устройства лотка: дно зажато между стенками, и его торец на 4 мм за
 * лицом стенки смотрит туда же - длиннее 2.4 м эта полоска уже спор за
 * глубину (кит, «одна плоскость»); стенка лотка на 1.5 см от стены - по той
 * же причине (её внутреннее лицо на 4 мм дальше наружного).
 */
const TRAY = { length: 2.4, off: 0.015 }

/** Генераторная: канистры у задней стены, верстак у перегородки медпункта. */
const JERRYCANS_X = { full: 5.3, empty: 4.85 }
const WORKBENCH_Z = -4.76

/** Медпункт: раковина у задней стены, аптечка на западной, весы в углу. */
const BASIN_X = 1.6
const MED_CABINET = { z: -5.9, y: 1.45 }
const FOLDED_COT_Z = -6.3
const SCALES_X = 2.55

/** Кают-компания: стол под живой трубкой, стул у него лицом к проёму в коридор. */
const TABLE_E = { x: -3.5, z: -2.4, w: 1.6, d: 0.8, h: 0.75 }
const CHAIR_E = { x: -3.1, z: -3.05 }
const SIDEBOARD_H = 0.9
const CUP_SHELF = { x: -3.4, y: 1.55 }

/** Пост: стол под окном, пульт у задней стены над гильзой кабелей, полка на западной. */
const DESK = { w: 1.4, d: 0.7, h: 0.75 }
const JOURNAL = { dx: 0.1, dz: -0.12 }
const PEN = { dx: 0.43, dz: -0.14, yaw: 0.4 }
const DESK_CHAIR_Z = -1.26
const CONSOLE = { w: 2.8, d: 0.7, h: 1.1 }
const BOOK_SHELF = { z: -4.6, y: 1.45, width: 1.0, depth: 0.24, books: 8 }
/** Плащ-палатка на крючке в откосе проёма в кают-компанию: планка под перемычкой. */
const CAPE = { plank: 0.12, below: 0.01 }
/**
 * Щель между уголком крышки люка и стенкой проёма. Стенка уголка - 5 мм
 * стали: вплотную к бетону её внутреннее лицо легло бы в 5 мм перед стенкой
 * проёма той же стороной (спор за глубину). Щель больше сантиметра снимает
 * спор; сама щель в полу - как у настоящего люка.
 */
const HATCH_SLOT = 0.011

/** Лаборатория: два стола вдоль фасада с проходом между ними. */
const LAB_TABLE = { w: 2.4, d: 0.8, h: 0.78, gap: 0.3 }
const RACK = { w: 2.0, d: 0.5, h: 1.8, shelves: 3 }
/** Кусты на полках стеллажа: полка, место вдоль полки; ближе к краю полки, мимо ламп. */
const TOMATOES: Array<[number, number]> = [
  [0, -0.55],
  [0, 0.35],
  [1, -0.2],
  [1, 0.6],
  [2, -0.6],
  [2, 0.15],
]
const TOMATO_Z = 0.11
/**
 * Горшок стоит на полке с зазором в 2 мм: его внутреннее дно ровно в
 * сантиметре над низом, и на полке оно ложилось бы на грани порога спора за
 * глубину с её верхом.
 */
const POT_LIFT = 0.002
const JARS_X = [-0.9, -0.78, -0.66, -0.54, -0.42]

/** Кубрик: койки у западной стены, шкафчики вдоль перегородки, столик между койкой и нарами. */
const BUNK = { w: 0.9, l: 2.0 }
const BUNKS_Z = [-6.69, -4.39]
const COT_Z = -1.33
const MATTRESS = { l: 0.8, z: -0.55 }
const LOCKERS = { n: 5, pitch: 0.51 }
const NIGHTSTAND_Z = -2.86
const PHOTO_Y = 1.25

/** Нижний ярус: ящик на крышке иллюминатора стоит чуть наискось. */
const CRATE_YAW = 0.3
const TARP_CLEAR = 0.06
const CLIMATE = { w: 1.2, d: 0.5, h: 1.2 }
/**
 * Насос на подкладках в 3 мм: полка швеллера рамы - 8 мм, и на полу её верх
 * ложился бы ближе сантиметра над полом той же стороной. Под водой низа
 * подкладок не видно.
 */
const PUMP_SHIM = 0.003

/** Холодная: пять капсул в ряд поперёк взгляда из окошка двери. */
const PODS = { n: 5, pitch: 1.2 }

// --- Как встать --------------------------------------------------------------------

type Wall = 'z0' | 'z1' | 'x0' | 'x1'
/** Лицом от стены в комнату. */
const FACING: Record<Wall, number> = { z0: 0, z1: Math.PI, x0: Math.PI / 2, x1: -Math.PI / 2 }

/** Точка на стене комнаты: `u` - вдоль стены, `off` - от грани в комнату. */
function wall(room: RoomId, w: Wall, u: number, y: number, off = 0): { at: Vec3; yaw: number } {
  const r = ROOMS[room]
  const at: Vec3 = w === 'z0' ? [u, y, r.z0 + off] : w === 'z1' ? [u, y, r.z1 - off] : w === 'x0' ? [r.x0 + off, y, u] : [r.x1 - off, y, u]
  return { at, yaw: FACING[w] }
}

/** У стены тылом: точка - середина тыла по рамке предмета. */
function back<T extends Made>(t: T): T {
  t.group.updateMatrixWorld(true)
  const bb = new THREE.Box3().setFromObject(t.group)
  return { ...t, point: new THREE.Vector3(0, 0, bb.min.z) }
}

/** Точка светильника. */
function spot(id: FixtureId): Vec3 {
  const f = fixture(id)
  return [f.x, f.y, f.z]
}

/** Горящие роли светильника: цвет и сила; сила идёт за светильником. */
function lit(id: FixtureId, roles: Partial<Record<GlowRole, [number, number]>>): Palette {
  const out: Palette = {}
  for (const [role, [color, strength]] of Object.entries(roles) as Array<[GlowRole, [number, number]]>) out[role] = { glow: role, color, strength, fixture: id }
  return out
}

const vec = (p: THREE.Vector3): Vec3 => [p.x, p.y, p.z]

// --- Краска мира ----------------------------------------------------------------------

/** Краски ролей словаря каталога. Светящиеся - погасшие: горит только `lit`. */
export const PALETTE: Palette = {
  /** Казённая масляная: серо-зелёная. */
  paint: { kind: 'paint', color: 0x7a8c80 },
  /** Вторая краска: серо-голубая, темнее - кант, цоколь, ручки. */
  paint2: { kind: 'paint', color: 0x66747a },
  steel: { kind: 'steel', color: 0x8e9290 },
  rust: { kind: 'rust', color: 0x7c5436 },
  /** Дерево тёмное, морёное временем. */
  wood: { kind: 'wood', color: 0x806044 },
  /** Ткань пыльная. */
  cloth: { kind: 'cloth', color: 0x8a8474 },
  rubber: { kind: 'rubber', color: 0x5c5a54 },
  glass: { glass: true, color: 0xa9b8b4, opacity: 0.35 },
  water: { glass: true, color: 0x4f5c50, opacity: 0.75 },
  /** Эмаль белая с желтизной. */
  enamel: { kind: 'enamel', color: 0xbdb7a0 },
  paper: { kind: 'paper', color: 0xb9b29c },
  photo: { kind: 'photo', color: 0x8a8580 },
  /** Карболит: коричневый. */
  plastic: { kind: 'plastic', color: 0x76624e },
  brass: { kind: 'brass', color: 0xa38850 },
  soil: { kind: 'soil', color: 0x5c4b38 },
  leaf: { kind: 'leaf', color: 0x55803e },
  fruit: { kind: 'fruit', color: 0xb02a1c },
  tube: { kind: 'paper', color: 0x9ea39f },
  bulb: { kind: 'paper', color: 0xaaa493 },
  screen: { kind: 'plastic', color: 0x44524a },
  dial: { kind: 'paper', color: 0xb3a98f },
  led: { kind: 'plastic', color: 0x5e403a },
  shade: { kind: 'plastic', color: 0x46644c },
}

/** Трубка, которая горит цветом своего светильника. */
const tube = (id: FixtureId, strength = 2.4): Palette => lit(id, { tube: [fixture(id).color, strength] })
/** Погасшая трубка: люминофор серый, концы в ожогах. */
const DEAD_TUBE: Look = { kind: 'burnt', color: 0xa3a8a4, span: TUBE_LIGHT }

const DUSTY_COAT: Look = { kind: 'cloth', color: 0x7c7f6c }
const CAPE_CLOTH: Look = { kind: 'cloth', color: 0x75714f }
const RED: Look = { kind: 'paint', color: 0xa5281e }

// --- Опись по комнатам ---------------------------------------------------------------

const A = ROOMS.A
const B = ROOMS.B
const E = ROOMS.E
const F = ROOMS.F
const G = ROOMS.G
const H = ROOMS.H
const J = ROOMS.J

/** Трубка под плоским потолком блока, трубкой в точке светильника. */
function ceilingTube(name: string, id: FixtureId, looks: Palette = tube(id)): Item {
  return {
    name,
    make: (m) => {
      const t = tubeFixture({ mats: m })
      return { ...t, point: t.tube }
    },
    at: spot(id),
    pin: 'xyz',
    looks,
  }
}

/** Трубка под сводом ангара на подвесах: от свода до точки светильника. */
function vaultTube(name: string, id: FixtureId, looks: Palette): Item {
  const f = fixture(id)
  return {
    name,
    make: (m) => {
      const t = tubeFixture({ rods: vaultY(f.z) - f.y - TUBE_DROP, mats: m })
      return { ...t, point: t.tube }
    },
    at: spot(id),
    pin: 'xyz',
    looks,
  }
}

/** Лампа в сетке на стене: колба в точке `at`, пластина на грани стены. */
function wallCage(name: string, id: FixtureId, room: RoomId, w: Wall): Item {
  const f = fixture(id)
  const r = ROOMS[room]
  const z = w === 'z0' ? r.z0 : r.z1
  return {
    name,
    make: (m) => {
      const l = cageLamp({ mount: 'wall', mats: m })
      return { ...l, point: new THREE.Vector3(l.bulb.x, l.bulb.y, 0) }
    },
    at: [f.x, f.y, z],
    yaw: FACING[w],
    pin: 'xyz',
    looks: lit(id, { bulb: [f.color, 2.5] }),
  }
}

const ROOM_A: Item[] = [
  ceilingTube('lamp-A', 'A'),
  {
    // Вешалка на пять крючков, плащи на всех, кроме первого от двери.
    name: 'coat-board',
    make: (m) => {
      const b = coatBoard({ hooks: COAT_BOARD.hooks, w: COAT_BOARD.w, mats: m })
      // В тесном ряду плащ шириной в шаг крючков (README ядра, «Плащ - одно тело»).
      const step = b.hooks[1].x - b.hooks[0].x
      b.hooks.forEach((h, i) => {
        if (i === 0) return
        const c = coat({ width: step, reach: h.z, seed: i + 1, mats: m })
        c.group.position.copy(h)
        b.group.add(c.group)
      })
      return b
    },
    ...wall('A', 'x0', half(A.z0, A.z1), COAT_BOARD.y),
    looks: { cloth: DUSTY_COAT },
  },
  ...BOOTS_Z.map(
    (z, i): Item => ({
      name: `boots-${i + 1}`,
      make: (m) => back(boots({ mats: m })),
      ...wall('A', 'x0', z, FLOOR.y, OFF),
      pin: 'xz',
      looks: { rubber: { kind: 'rubber', color: 0x5a5e56 } },
    }),
  ),
  { name: 'bench', make: (m) => back(bench({ mats: m })), ...wall('A', 'z1', BENCH_X, FLOOR.y, OFF), pin: 'xz', solid: true },
  // Зеркало на правой стене, если войти с улицы, под простынёй.
  { name: 'mirror', make: (m) => coveredMirror({ mats: m }), ...wall('A', 'x1', half(A.z0, A.z1), MIRROR_Y), looks: { cloth: { kind: 'cloth', color: 0xa39d8a } } },
]

const ROOM_B: Item[] = [
  ceilingTube('lamp-B', 'B'),
  {
    // Лоток кабелей под потолком вдоль северной стены, от щита в торце.
    name: 'cable-tray',
    make: (m) => {
      const t = cableTray({ length: TRAY.length, cables: 4, mats: m })
      return { ...t, point: new THREE.Vector3(0, t.h, t.d / 2) }
    },
    at: [B.x1 - TRAY.length, BLOCK_CEILING, B.z1 - TRAY.off],
    pin: 'xyz',
  },
  { name: 'extinguisher', make: (m) => extinguisher({ mats: m }), ...wall('B', 'z0', EXTINGUISHER.x, EXTINGUISHER.y), looks: { paint: RED } },
  { name: 'panel-box', make: (m) => panelBox({ mats: m }), ...wall('B', 'x1', half(B.z0, B.z1), PANEL_Y) },
]

const ROOM_C: Item[] = [
  {
    // Рабочая лампа в сетке на шнуре от потолка.
    name: 'lamp-C',
    make: (m) => {
      const l = cageLamp({ mount: 'hang', cord: BLOCK_CEILING - fixture('C').y - CAGE_DROP, mats: m })
      return { ...l, point: l.bulb }
    },
    at: spot('C'),
    pin: 'xyz',
    looks: lit('C', { bulb: [fixture('C').color, 3] }),
  },
  {
    name: 'generator',
    make: (m) => generator({ mats: m }),
    at: [GENERATOR.x, FLOOR.y, GENERATOR.z],
    solid: true,
    looks: { paint: { kind: 'paint', color: 0x6f7a5c }, paint2: { kind: 'paint', color: 0x5d6556 }, glass: { glass: true, color: 0x8a9690, opacity: 0.5 } },
  },
  { name: 'jerrycan-full', make: (m) => back(jerrycan({ full: true, mats: m })), ...wall('C', 'z0', JERRYCANS_X.full, FLOOR.y, OFF), pin: 'xz', solid: true, loose: true, looks: { paint: { kind: 'paint', color: 0x5f6e4e } } },
  { name: 'jerrycan-empty', make: (m) => back(jerrycan({ full: false, mats: m })), ...wall('C', 'z0', JERRYCANS_X.empty, FLOOR.y, OFF), pin: 'xz', solid: true, looks: { paint: { kind: 'paint', color: 0x5f6e4e } } },
  { name: 'workbench', make: (m) => back(workbench({ mats: m })), ...wall('C', 'x0', WORKBENCH_Z, FLOOR.y, OFF), pin: 'xz', solid: true },
]

const ROOM_D: Item[] = [
  ceilingTube('lamp-D', 'D', tube('D', 2.2)),
  {
    name: 'washbasin',
    make: (m) => washbasin({ mats: m }),
    ...wall('D', 'z0', BASIN_X, FLOOR.y),
    solid: true,
    looks: { enamel: { kind: 'enamel', color: 0xb7ae96 } },
  },
  {
    // Бинт рулоном на боковом крае чаши, хвост вдоль края к переду.
    name: 'bandage',
    make: (m) => bandage({ mats: m }),
    on: 'washbasin',
    at: (w) => [w.w / 2 - 0.0125, w.rim, w.d / 2],
    looks: { cloth: { kind: 'cloth', color: 0xa39486 } },
  },
  {
    // Ножницы плашмя на переднем крае чаши.
    name: 'scissors',
    make: (m) => scissors({ mats: m }),
    on: 'washbasin',
    at: (w) => [-0.08, w.rim, w.d - 0.0125],
  },
  {
    name: 'med-cabinet',
    make: (m) => medCabinet({ open: true, mats: m }),
    ...wall('D', 'x0', MED_CABINET.z, MED_CABINET.y),
    looks: { paint: { kind: 'paint', color: 0xa9a898 }, paint2: { kind: 'paint', color: 0x9a2b22 } },
  },
  { name: 'folded-cot', make: (m) => back(foldedCot({ mats: m })), ...wall('D', 'x1', FOLDED_COT_Z, FLOOR.y, OFF), pin: 'xz', solid: true, looks: { cloth: { kind: 'cloth', color: 0x6f6a4e } } },
  { name: 'scales', make: (m) => back(scales({ mats: m })), ...wall('D', 'z0', SCALES_X, FLOOR.y, OFF), pin: 'xz', solid: true, looks: { paint: { kind: 'paint', color: 0xa9a898 } } },
]

/** Стул стоит лицом к середине проёма из коридора. */
const faceBE = (() => {
  const x = E.x1
  const z = half(OPENINGS.BE.z0, OPENINGS.BE.z1)
  return Math.atan2(x - CHAIR_E.x, z - CHAIR_E.z)
})()

const ROOM_E: Item[] = [
  vaultTube('lamp-E1', 'E1', tube('E1', 2.6)),
  vaultTube('lamp-E2', 'E2', { tube: DEAD_TUBE }),
  {
    name: 'table-E',
    make: (m) => table({ w: TABLE_E.w, d: TABLE_E.d, h: TABLE_E.h, mats: m }),
    at: [TABLE_E.x, FLOOR.y, TABLE_E.z],
    solid: true,
    looks: { top: { kind: 'wood', color: 0x7a5a3e }, legs: { kind: 'paint', color: 0x5e5a4c } },
  },
  { name: 'chair-E', make: (m) => chair({ mats: m }), at: [CHAIR_E.x, FLOOR.y, CHAIR_E.z], yaw: faceBE, solid: true },
  {
    // Кружка с налитым у края стола со стороны стула, сахарница рядом.
    name: 'mug',
    make: (m) => mug({ fill: 0.8, mats: m }),
    on: 'table-E',
    at: (t) => [0.35, t.h, -0.2],
    looks: { paint2: { kind: 'paint', color: 0x4a5460 }, water: { glass: true, color: 0x6b4a2a, opacity: 0.9 } },
  },
  { name: 'sugar-bowl', make: (m) => sugarBowl({ mats: m }), on: 'table-E', at: (t) => [-0.1, t.h, -0.1], looks: { paint2: { kind: 'paint', color: 0x4a5460 } } },
  // Четыре стула стопкой в углу у фасада.
  { name: 'chair-stack', make: (m) => back(chairStack({ n: 4, mats: m })), ...wall('E', 'z1', E.x1 - 0.23, FLOOR.y, OFF), pin: 'xz', solid: true },
  {
    name: 'sideboard',
    make: (m) => back(sideboard({ h: SIDEBOARD_H, mats: m })),
    ...wall('E', 'z1', SOURCES.receiver.x, FLOOR.y, OFF),
    pin: 'xz',
    solid: true,
    looks: { paint: { kind: 'paint', color: 0x6e5a44 } },
  },
  {
    name: 'radio',
    make: (m) => radio({ mats: m }),
    at: [SOURCES.receiver.x, SIDEBOARD_H, SOURCES.receiver.z],
    yaw: Math.PI,
    looks: { wood: { kind: 'wood', color: 0x74523a }, cloth: { kind: 'cloth', color: 0x7d7058 }, ...lit('E1', { dial: [0xffb060, 0.55] }) },
  },
  {
    // Полка с пятью чашками: четыре пыльные, одна мытая.
    name: 'cup-shelf',
    make: (m) => cupShelf({ cups: 5, mats: m }),
    ...wall('E', 'z1', CUP_SHELF.x, CUP_SHELF.y),
    parts: {
      'cup-1': { kind: 'enamel', color: 0xa39f8e },
      'cup-2': { kind: 'enamel', color: 0xa39f8e },
      'cup-3': { kind: 'enamel', color: 0xc4bfaa },
      'cup-4': { kind: 'enamel', color: 0xa39f8e },
      'cup-5': { kind: 'enamel', color: 0xa39f8e },
    },
  },
  {
    name: 'bucket',
    make: (m) => bucket({ water: true, mats: m }),
    at: [SOURCES.bucket.x, FLOOR.y, SOURCES.bucket.z],
    solid: true,
    looks: { water: { glass: true, color: 0x55604f, opacity: 0.8 } },
  },
  {
    name: 'clock',
    make: (m) => wallClock({ mats: m }),
    ...wall('E', 'x0', SOURCES.clock.z, SOURCES.clock.y),
    looks: { paint: { kind: 'paint', color: 0x5f6468 } },
  },
]

/** Окно поста: письменный стол под ним. */
const POST_WINDOW = HANGAR_WINDOWS.xs.find((x) => x > F.x0 && x < F.x1)!
const deskZ = F.z1 - OFF - DESK.d / 2

const ROOM_F: Item[] = [
  {
    name: 'desk',
    make: (m) => back(desk({ w: DESK.w, d: DESK.d, h: DESK.h, mats: m })),
    ...wall('F', 'z1', POST_WINDOW, FLOOR.y, OFF),
    pin: 'xz',
    solid: true,
  },
  {
    // Лампа с зелёным абажуром: лампочка над точкой светильника, основание на столе.
    name: 'desk-lamp',
    make: (m) => {
      const l = deskLamp({ mats: m })
      return { ...l, point: l.bulb }
    },
    at: [fixture('F').x, DESK.h, fixture('F').z],
    yaw: Math.PI,
    pin: 'xz',
    looks: lit('F', { bulb: [fixture('F').color, 3], shade: [0x3a8f55, 0.8] }),
  },
  {
    name: 'journal',
    make: (m) => openBook({ mats: m }),
    at: [POST_WINDOW + JOURNAL.dx, DESK.h, deskZ + JOURNAL.dz],
    yaw: Math.PI,
    looks: { cloth: { kind: 'cloth', color: 0x5f5448 } },
  },
  { name: 'pen', make: (m) => pen({ mats: m }), at: [POST_WINDOW + PEN.dx, DESK.h, deskZ + PEN.dz], yaw: Math.PI + PEN.yaw },
  { name: 'desk-chair', make: (m) => chair({ mats: m }), at: [POST_WINDOW + JOURNAL.dx, FLOOR.y, DESK_CHAIR_Z], solid: true },
  {
    name: 'console',
    make: (m) => back(listeningConsole({ w: CONSOLE.w, d: CONSOLE.d, h: CONSOLE.h, mats: m })),
    ...wall('F', 'z0', CABLE_SLEEVE.x, FLOOR.y, OFF),
    pin: 'xz',
    solid: true,
    looks: lit('F', { screen: [0x33e070, 0.8], dial: [0xffc070, 0.45] }),
  },
  {
    // Катушечный магнитофон на левом краю пульта, на месте, которое пульт оставил.
    name: 'recorder',
    make: (m) => tapeRecorder({ mats: m }),
    on: 'console',
    at: (c) => vec(c.recorder),
    looks: { paint: { kind: 'paint', color: 0x7a7468 }, rubber: { kind: 'rubber', color: 0x5c4a3a }, ...lit('F', { dial: [0xffc070, 0.4] }) },
  },
  {
    // Полка с томами на западной стене: тыл полки на стене.
    name: 'book-shelf',
    make: (m) => shelfWithBooks({ n: BOOK_SHELF.books, width: BOOK_SHELF.width, depth: BOOK_SHELF.depth, mats: m }),
    ...wall('F', 'x0', BOOK_SHELF.z, BOOK_SHELF.y, BOOK_SHELF.depth / 2),
    looks: {
      pages: { kind: 'paper', color: 0xb3ab94 },
      mug: { kind: 'enamel', color: 0xa39f8e },
      ...Object.fromEntries(Array.from({ length: BOOK_SHELF.books }, (_, i) => [`cover${i}`, { kind: 'cloth', color: 0x55604e } as Look])),
    },
  },
  {
    // Крышка люка над проёмом лестницы: створки `leaf-left`, `leaf-right`.
    name: 'hatch',
    make: (m) => hatchLid({ w: HATCH.x1 - HATCH.x0 - 2 * HATCH_SLOT, l: HATCH.z1 - HATCH.z0 - 2 * HATCH_SLOT, mats: m }),
    at: [half(HATCH.x0, HATCH.x1), FLOOR.y, half(HATCH.z0, HATCH.z1)],
    looks: lit('F', { led: [0xff2010, 1.4] }),
  },
  {
    // Плащ-палатка на крючке в южном откосе проёма в кают-компанию: виден из
    // кают-компании в проёме, на фоне пульта. Крючок на планке под перемычкой.
    name: 'cape',
    make: (m) => {
      const b = coatBoard({ hooks: 1, w: CAPE.plank, mats: m })
      const c = coat({ cape: true, reach: b.hooks[0].z, seed: 7, mats: m })
      c.group.position.copy(b.hooks[0])
      b.group.add(c.group)
      b.group.updateMatrixWorld(true)
      const top = new THREE.Box3().setFromObject(b.group).max.y
      return { ...b, point: new THREE.Vector3(0, top, 0) }
    },
    at: [HANGAR_WALLS.EF - 0.01, FLOOR.y + DOORWAY.h - CAPE.below, OPENINGS.EF.z0],
    yaw: 0,
    pin: 'xyz',
    looks: { cloth: CAPE_CLOTH },
  },
]

/** Середины двух столов лаборатории: по краям комнаты, проход между ними. */
const labTableX = [G.x0 + (G.x1 - G.x0 - 2 * LAB_TABLE.w - LAB_TABLE.gap) / 2 + LAB_TABLE.w / 2, G.x1 - (G.x1 - G.x0 - 2 * LAB_TABLE.w - LAB_TABLE.gap) / 2 - LAB_TABLE.w / 2]
const labTop: Palette = { top: { kind: 'paint', color: 0x8f9a90 }, legs: { kind: 'paint', color: 0x66747a } }

const ROOM_G: Item[] = [
  ...labTableX.map(
    (x, i): Item => ({
      name: `lab-table-${i + 1}`,
      make: (m) => table({ w: LAB_TABLE.w, d: LAB_TABLE.d, h: LAB_TABLE.h, mats: m }),
      at: [x, FLOOR.y, G.z1 - OFF - LAB_TABLE.d / 2],
      solid: true,
      looks: labTop,
    }),
  ),
  {
    // Стеллаж рассады у задней стены, фитолампа над каждой полкой.
    name: 'plant-rack',
    make: (m) => back(plantRack({ w: RACK.w, d: RACK.d, h: RACK.h, shelves: RACK.shelves, mats: m })),
    ...wall('G', 'z0', fixture('G').x, FLOOR.y, OFF),
    pin: 'xz',
    solid: true,
    looks: lit('G', { tube: [fixture('G').color, 2.2] }),
  },
  ...TOMATOES.map(
    ([shelf, x], i): Item => ({
      name: `tomato-${i + 1}`,
      make: (m) => tomatoPlant({ seed: i + 3, mats: m }),
      on: 'plant-rack',
      at: (r) => [x, r.shelves[shelf] + POT_LIFT, TOMATO_Z],
      looks: { plastic: { kind: 'plastic', color: 0x7a5a44 } },
    }),
  ),
  ...JARS_X.map(
    (x, i): Item => ({
      name: `jar-${i + 1}`,
      make: (m) => jar({ fill: 0.55 + 0.05 * (i % 3), mats: m }),
      on: 'lab-table-2',
      at: (t) => [x, t.h, 0.1],
    }),
  ),
  { name: 'microscope', make: (m) => microscope({ mats: m }), on: 'lab-table-1', at: (t) => [0.5, t.h, 0.05], yaw: 0.3 },
  { name: 'tag-box', make: (m) => tagBox({ mats: m }), on: 'lab-table-1', at: (t) => [-0.4, t.h, 0.15] },
  { name: 'lab-sink', make: (m) => washbasin({ mats: m }), ...wall('G', 'x0', SOURCES.labSink.z, FLOOR.y), solid: true },
]

const bunkX = H.x0 + OFF + BUNK.w / 2
const lockerZ = (i: number) => H.z0 + OFF + 0.25 + i * LOCKERS.pitch

const ROOM_H: Item[] = [
  ...BUNKS_Z.map(
    (z, i): Item => ({
      name: `bunk-${i + 1}`,
      make: (m) => bunk({ w: BUNK.w, l: BUNK.l, mats: m }),
      at: [bunkX, FLOOR.y, z],
      solid: true,
      looks: { paint: { kind: 'paint', color: 0x6a767a } },
    }),
  ),
  {
    name: 'cot',
    make: (m) => cot({ w: BUNK.w, l: BUNK.l, mats: m }),
    at: [bunkX, FLOOR.y, COT_Z],
    solid: true,
    looks: { paint: { kind: 'paint', color: 0x6a767a }, cloth: { kind: 'cloth', color: 0x7d7f78 } },
  },
  // Четыре скатанных матраса на голых досках нар.
  ...[0, 1, 2, 3].map(
    (k): Item => ({
      name: `mattress-${k + 1}`,
      make: (m) => rolledMattress({ l: MATTRESS.l, mats: m }),
      on: `bunk-${1 + (k >> 1)}`,
      at: (b) => [0, b.levels[k & 1], MATTRESS.z],
      looks: { cloth: { kind: 'cloth', color: 0x958f7c } },
    }),
  ),
  // Пять шкафчиков вдоль перегородки: ближний к двери открыт, остальные опечатаны.
  ...Array.from(
    { length: LOCKERS.n },
    (_, i): Item => ({
      name: `locker-${i + 1}`,
      make: (m) => back(i === LOCKERS.n - 1 ? locker({ open: true, mats: m }) : locker({ sealed: true, mats: m })),
      ...wall('H', 'x1', lockerZ(i), FLOOR.y, OFF),
      pin: 'xz',
      solid: true,
      looks: { paint: { kind: 'paint', color: 0x7a8a80 }, paper: { kind: 'paper', color: 0xc0b89e } },
    }),
  ),
  { name: 'nightstand', make: (m) => back(nightstand({ mats: m })), ...wall('H', 'x0', NIGHTSTAND_Z, FLOOR.y, OFF), pin: 'xz', solid: true },
  {
    // Ночник: мёртвый, лампочка и абажур не горят.
    name: 'night-lamp',
    make: (m) => nightLamp({ mats: m }),
    on: 'nightstand',
    at: (n) => [0.08, n.top, -0.05],
    looks: { shade: { kind: 'cloth', color: 0x8a7a5a } },
  },
  { name: 'photo', make: (m) => photoFrame({ mats: m }), ...wall('H', 'x0', NIGHTSTAND_Z, PHOTO_Y) },
]

const ROOM_I: Item[] = [
  wallCage('lamp-I1', 'I1', 'I', 'z0'),
  wallCage('lamp-I2', 'I2', 'I', 'z1'),
  {
    // Иллюминатор: обод садится в круглый проём пола.
    name: 'porthole',
    make: (m) => porthole({ d: 2 * PORTHOLE_HOLE, mats: m }),
    at: [PORTHOLE.x, LOWER.floor, PORTHOLE.z],
    looks: { steel: { kind: 'steel', color: 0x7f8482 }, glass: { glass: true, color: 0x3a4a52, opacity: 0.6 } },
  },
  {
    // Ящик на крышке иллюминатора, на её штурвале.
    name: 'crate',
    make: (m) => crate({ mats: m }),
    on: 'porthole',
    at: (p) => vec(p.top),
    yaw: CRATE_YAW,
    solid: true,
    loose: true,
    looks: { wood: { kind: 'wood', color: 0x7d6448 } },
  },
  {
    // Пульт климата в нише западной стены, лицом в насосную.
    name: 'climate',
    make: (m) => back(climateConsole({ w: CLIMATE.w, d: CLIMATE.d, h: CLIMATE.h, mats: m })),
    ...wall('I', 'x0', half(LOWER.niche.z0, LOWER.niche.z1), LOWER.floor, TARP_CLEAR),
    pin: 'xz',
    solid: true,
    looks: { paint: { kind: 'paint', color: 0x7c8c86 } },
  },
  { name: 'tarp', make: (m) => tarp({ w: CLIMATE.w, d: CLIMATE.d, h: CLIMATE.h, mats: m }), on: 'climate', at: [0, 0, 0], solid: true, loose: true, looks: { cloth: { kind: 'cloth', color: 0x6f6a4c } } },
  {
    // Насосный агрегат вдоль западной стены, перед стояками.
    name: 'pump',
    make: (m) => pump({ mats: m }),
    at: [SOURCES.pump.x, LOWER.floor + PUMP_SHIM, SOURCES.pump.z],
    yaw: Math.PI / 2,
    solid: true,
    looks: { paint: { kind: 'paint', color: 0x5f6f66 } },
  },
]

const podLooks: Palette = {
  paint: { kind: 'paint', color: 0x9aa2a4 },
  paint2: { kind: 'paint', color: 0x6c7478 },
  glass: { glass: true, color: 0xc8d8e0, opacity: 0.72 },
  cloth: { kind: 'cloth', color: 0x9a9a92 },
}

const ROOM_J: Item[] = [
  {
    // Синий свет холодной: трубка под потолком над рядом капсул.
    name: 'lamp-J',
    make: (m) => tubeFixture({ mats: m }),
    at: [fixture('J').x, LOWER.ceiling, fixture('J').z],
    looks: tube('J', 1.8),
  },
  // Пять капсул в ряд: четыре заняты, пятая открыта и пуста, огоньки у неё не горят.
  ...Array.from(
    { length: PODS.n },
    (_, i): Item => ({
      name: `pod-${i + 1}`,
      make: (m) => (i === PODS.n - 1 ? pod({ open: true, occupied: false, mats: m }) : pod({ mats: m })),
      at: [half(J.x0, J.x1), LOWER.floor, half(COLD_DOOR.z0, COLD_DOOR.z1) + (i - (PODS.n - 1) / 2) * PODS.pitch],
      looks: i === PODS.n - 1 ? podLooks : { ...podLooks, ...lit('J', { led: [0x3cff8a, 1.1] }) },
    }),
  ),
]

/**
 * Чьи подвижные части этот этап двигает: только створки люка
 * (`debug.openHatch` в main.ts). У остальных предметов стрелки, тумблеры,
 * катушки, дверцы и крышки слиты с неподвижным своей комнаты: вызов отрисовки
 * на комнату, а не на каждую стрелку, - иначе нутро, видное с поляны сквозь
 * стены, одно съедает рамку кадра. Этап рук оживит нужные, добавив имя сюда.
 */
export const LIVE = new Set(['hatch', 'generator', 'jerrycan-full', 'console', 'recorder', 'crate', 'porthole', 'climate', 'tarp'])

const settle = (items: Item[]): Item[] => items.map((i) => (LIVE.has(i.name) ? i : { ...i, still: true }))

/** Обстановка по комнатам: тест проверяет, что каждый предмет в своей. */
export const ROOM_ITEMS: Record<RoomId, Item[]> = {
  A: settle(ROOM_A),
  B: settle(ROOM_B),
  C: settle(ROOM_C),
  D: settle(ROOM_D),
  E: settle(ROOM_E),
  F: settle(ROOM_F),
  G: settle(ROOM_G),
  H: settle(ROOM_H),
  I: settle(ROOM_I),
  J: settle(ROOM_J),
}

/** Всё нутро одним списком: так его берёт `furnishSteps`. */
export const PLACEMENT: Item[] = Object.values(ROOM_ITEMS).flat()

/** Какой предмет - какой светильник. */
export const LAMPS: Record<FixtureId, string> = {
  A: 'lamp-A',
  B: 'lamp-B',
  C: 'lamp-C',
  D: 'lamp-D',
  E1: 'lamp-E1',
  E2: 'lamp-E2',
  F: 'desk-lamp',
  G: 'plant-rack',
  I1: 'lamp-I1',
  I2: 'lamp-I2',
  J: 'lamp-J',
}

/**
 * Светильники, чья точка не в колбе или трубке своего предмета, - поимённо и
 * с причиной. Трубки и лампы в сетке обязаны светить из себя; настольная
 * лампа светит из-под абажура, стеллаж - перед полками, холодная - над рядом
 * капсул (так их поставила раскладка света). Лишнее в списке - ошибка теста.
 */
export const LAMP_APART: Partial<Record<FixtureId, string>> = {
  F: 'свет под абажуром, на ладонь ниже лампочки: круг на столе, а не на потолке',
  G: 'стеллаж тылом к стене, свет перед полками',
  J: 'трубка под потолком, свет у пола над капсулами',
}
