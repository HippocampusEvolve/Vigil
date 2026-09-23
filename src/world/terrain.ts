/**
 * world/terrain.ts — земля поляны формулой.
 *
 * Земля считается аналитически, а не деревом коллизий: формула точнее
 * треугольников и ничего не стоит при сборке. Опора тела (`support.ts`)
 * спрашивает её в каждой точке шага, внешние проверки - в каждой точке
 * маршрута, сетка земли (`ground.ts`) - в каждой вершине. Копий нет.
 *
 * Простая идея, как у мокрой простыни на кочках. Основа - мягкие волны грязи
 * высотой в ладонь; у поста их разглаживает отмостка и вытоптанная тропа; в
 * низинах волн стоит вода, и лужа - это просто срезанная по уровню низина,
 * ровная, как зеркало. Поверх - две рукотворные формы: промоина ручья вдоль
 * западного края и вмятина там, где лежало тело.
 */

import { BLOCK, CLEARING, GUTTER, HANGAR, PLINTH, STREAM, TRAIL, WAKE_POINT } from './layout'

/** Высота волн грязи, м: от гребня до середины. */
const WAVE = 0.15

/**
 * Волны - сумма трёх косых синусов с длинами 6-10 м. Направления и фазы
 * несоизмеримы, поэтому рисунок не повторяется в пределах поляны.
 */
const WAVES: ReadonlyArray<readonly [number, number, number, number]> = [
  // kx, kz, фаза, вес
  [0.52, 0.41, 1.3, 0.5],
  [-0.38, 0.8, 0.2, 0.35],
  [0.71, -0.66, 2.1, 0.3],
]
const WAVE_NORM = 1 / (0.5 + 0.35 + 0.3)

/** Рамка поста в плане: стены ангара и блока, отмостка и навес. */
const POST = { x0: HANGAR.x0, x1: Math.max(BLOCK.x1, PLINTH.x1), z0: HANGAR.z0, z1: PLINTH.z1 } as const

/** На каком отступе от поста волны сходят на нет: у стен земля ровная. */
const FLAT_NEAR = 1.0
const FLAT_FAR = 5.0

/** Уровень, ниже которого в низине стоит вода. Лужи - не везде, см. `puddleMask`. */
const PUDDLE_LEVEL = -0.075

/** Глубина вытоптанной тропы, м: тропа ниже грязи рядом и потому мокрее. */
const TRAIL_DEPTH = 0.035

/** Вмятина пролога: эллипс вдоль тела, лежавшего головой к посту. */
const DENT = { cx: WAKE_POINT.x + 0.08, cz: WAKE_POINT.z + 0.72, half: 0.88, width: 0.3, depth: 0.075, yaw: 0.22 }

/** Воронка под струёй водостока. */
const FUNNEL = { r: 0.75, depth: 0.14 }

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Расстояние от точки до рамки поста в плане; внутри - ноль. */
export function postDistance(x: number, z: number): number {
  const dx = Math.max(POST.x0 - x, 0, x - POST.x1)
  const dz = Math.max(POST.z0 - z, 0, z - POST.z1)
  return Math.hypot(dx, dz)
}

/** Расстояние до стен поста (без отмостки): по нему кладётся тропа. */
function wallDistance(x: number, z: number): number {
  const dx = Math.max(HANGAR.x0 - x, 0, x - BLOCK.x1)
  const dz = Math.max(HANGAR.z0 - z, 0, z - BLOCK.z1)
  return Math.hypot(dx, dz)
}

/** Ось ручья: вьётся внутри промоины, у мачты второго канала уходит к западу. */
export function streamCenter(z: number): number {
  return (STREAM.x0 + STREAM.x1) / 2 - 0.4 + 0.5 * Math.sin(0.19 * z - 3.09)
}

/** Волны грязи без рукотворного: в долях `WAVE`, от -1 до 1. */
function waves(x: number, z: number): number {
  let h = 0
  for (const [kx, kz, ph, w] of WAVES) h += w * Math.sin(kx * x + kz * z + ph)
  return h * WAVE_NORM
}

/**
 * Где низины держат воду. Одних волн мало: лужи вышли бы ровной сеткой по
 * всем впадинам. Медленный множитель оставляет воду только в части низин.
 */
function puddleMask(x: number, z: number): number {
  const m = Math.sin(0.23 * x + 1.7) * Math.sin(0.19 * z + 0.4) + 0.35 * Math.sin(0.11 * (x + z))
  return smooth(0.05, 0.35, m)
}

/** Вмятина от тела: 0 вне неё, 1 на дне. */
function dent(x: number, z: number): number {
  const c = Math.cos(DENT.yaw)
  const s = Math.sin(DENT.yaw)
  const dx = x - DENT.cx
  const dz = z - DENT.cz
  const along = (dx * s + dz * c) / DENT.half
  const across = (dx * c - dz * s) / DENT.width
  const r = along * along + across * across
  return r >= 1 ? 0 : (1 - r) * (1 - r)
}

/** Промоина ручья: 0 на поляне, 1 на дне русла. */
function channel(x: number, z: number): number {
  if (z < STREAM.z0 - 8 || z > STREAM.z1 + 8) return 0
  const d = Math.abs(x - streamCenter(z))
  const half = STREAM.water / 2
  // Дно шириной с воду, дальше крутой борт: за полтора метра до верха.
  return 1 - smooth(half, half + 1.5, d)
}

/** Сколько здесь тропы: 1 посреди полосы, 0 вне её. */
export function trailAt(x: number, z: number): number {
  const d = wallDistance(x, z)
  if (d <= 0) return 0
  const mid = (TRAIL.inner + TRAIL.outer) / 2
  const half = (TRAIL.outer - TRAIL.inner) / 2
  // Перед входом тропа уходит под отмостку и туда, где ходят все: не рисуем.
  if (x > PLINTH.x0 - 0.5 && x < PLINTH.x1 + 0.5 && z > 0 && z < PLINTH.z1 + 0.5) return 0
  return 1 - smooth(half * 0.6, half * 1.25, Math.abs(d - mid))
}

/** Высота до срезки лужами: всё, кроме воды. */
function rawHeight(x: number, z: number): number {
  const flat = smooth(FLAT_NEAR, FLAT_FAR, postDistance(x, z))
  let h = WAVE * waves(x, z) * flat
  h -= TRAIL_DEPTH * trailAt(x, z)
  h -= DENT.depth * dent(x, z)
  const fx = x - GUTTER.x
  const fz = z - GUTTER.z
  const f = 1 - Math.min(1, Math.hypot(fx, fz) / FUNNEL.r)
  if (f > 0) h -= FUNNEL.depth * f * f
  const ch = channel(x, z)
  if (ch > 0) h = h * (1 - ch) - STREAM.depth * ch
  return h
}

/** Уровень воды в низине или `-Infinity`, если здесь лужи не бывает. */
function puddleLevel(x: number, z: number): number {
  if (channel(x, z) > 0.02) return -Infinity
  if (postDistance(x, z) < 0.3) return -Infinity
  // Воронка у водостока всегда полна: туда бьёт струя.
  if (Math.hypot(x - GUTTER.x, z - GUTTER.z) < FUNNEL.r) return -FUNNEL.depth * 0.55
  return puddleMask(x, z) > 0.5 ? PUDDLE_LEVEL : -Infinity
}

/** Высота земли. Лужа - ровная вода по уровню, а не ямка под ней. */
export function heightAt(x: number, z: number): number {
  const h = rawHeight(x, z)
  const level = puddleLevel(x, z)
  return h < level ? level : h
}

/**
 * Высота и глубина воды одним заходом: сетка земли спрашивает обе в каждой
 * вершине, а по отдельности они считали бы рельеф дважды.
 */
export function groundSample(x: number, z: number, out: { h: number; water: number }): void {
  const h = rawHeight(x, z)
  const level = puddleLevel(x, z)
  if (h < level) {
    out.h = level
    out.water = level - h
  } else {
    out.h = h
    out.water = 0
  }
}

/** Глубина воды над грязью, м: 0 - сухо. По ней шаг решает, брызгать ли. */
export function waterDepth(x: number, z: number): number {
  const level = puddleLevel(x, z)
  const h = rawHeight(x, z)
  return h < level ? level - h : 0
}

/** Уровень воды в ручье: чуть ниже половины промоины. */
export const STREAM_LEVEL = -STREAM.depth + 0.14

/** Лежит ли точка внутри поляны (без рваного края). */
export function inClearing(x: number, z: number): boolean {
  return x >= CLEARING.minX && x <= CLEARING.maxX && z >= CLEARING.minZ && z <= CLEARING.maxZ
}
