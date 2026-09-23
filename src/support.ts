/**
 * support.ts — форма этого мира для тела из ядра (`world-core/core`).
 *
 * Ядро не знает ни Octree, ни рельефа, ни лестницы: оно спрашивает две вещи -
 * где под ногами пол и куда вытолкнуть из твёрдого, - а собирает ответы
 * отсюда. Перенесено из Winter Tower без изменений в логике: там это было
 * единственное, что привязывало контроллер к форме мира.
 *
 * Разделение работы такое: ВЫСОТУ ДЕРЖИТ `floorAt`, СТЕНЫ ДЕРЖИТ `resolve`.
 * Поэтому капсула выталкивания начинается не от подошвы, а на высоте
 * переступа: то, на что можно шагнуть (ступень марша, порог, кромка плиты),
 * стеной не считается и не отпихивает, иначе по лестнице было бы не подняться
 * вовсе - её подъём приходил бы раньше, чем пол под ногой.
 */

import * as THREE from 'three'
import { Capsule } from 'three/examples/jsm/math/Capsule.js'
import { Octree } from 'three/examples/jsm/math/Octree.js'
import type { Support } from 'world-core/core'
import { FLOOR, LOWER, STAIRS } from './world/layout'

/**
 * На чём стоим. Нужно звуку: грязь чавкает, бетон щёлкает, лужа брызжет,
 * стальной марш звенит. Пол нижнего яруса под водой по щиколотку - это вода.
 */
export type Surface = 'mud' | 'concrete' | 'water' | 'steel'

/** Что за настил под точкой: марш лестницы - сталь, пол низа - вода, прочее - бетон. */
export function deckSurface(x: number, y: number, z: number): Surface {
  const runEnd = STAIRS.top - (STAIRS.rises - 1) * STAIRS.tread
  if (x > STAIRS.x0 - 0.05 && x < STAIRS.x1 + 0.05 && z < STAIRS.top + 0.05 && z > runEnd - 0.05 && y < FLOOR.y - 0.05 && y > LOWER.floor + 0.05) return 'steel'
  if (y < LOWER.floor + LOWER.water) return 'water'
  return 'concrete'
}

/**
 * Круче ~57° — уже не пол, а скала: по ней съезжают, а не поднимаются.
 *
 * Правило живёт здесь, а не в ядре: у тела ядра нет состояния «сползание», и
 * знать про уклон ему незачем - оно спрашивает, есть ли пол, и получает
 * «нет».
 */
const MIN_FLOOR_NY = 0.55

/**
 * Переступ: ступенька ниже этого проходится шагом, а не прыжком. Отмостка
 * перед дверью (0.25) им и берётся. Внешние проверки проходимости мерят тем
 * же числом - расходиться им нельзя.
 */
export const STEP_UP = 0.3

/**
 * Подошва: точки, из которых опускаются лучи. Один луч в точку проваливается
 * в щель между плитами настила и цепляется за нижний пояс лестничной коробки -
 * опора мигает, и шаг по маршу превращается в прыжки. Крест по 18 см ловит
 * настил всей стопой, а перила и балки над головой отсекаются сами: луч идёт
 * ВНИЗ от высоты переступа.
 */
const FOOT_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.18, 0],
  [-0.18, 0],
  [0, 0.18],
  [0, -0.18],
]

/** Насколько разносим пробы высоты, считая нормаль рельефа конечными разностями. */
const GROUND_EPS = 0.6

/** Радиус столбика, которым собираются кандидаты в пол: крест подошвы с запасом. */
const COLUMN_R = 0.22

export function createSupport(opts: {
  /** Дерево построек. Рельефа в нём нет - его форму знает `heightAt`. */
  octree: Octree
  /** Высота рельефа. Земля считается формулой, а не деревом (world/terrain.ts). */
  heightAt: (x: number, z: number) => number
  /** Глубина воды над грязью: в луже шаг брызжет. Нет - луж нет. */
  waterAt?: (x: number, z: number) => number
}): Support {
  const { octree, heightAt, waterAt } = opts

  const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.34)
  // Капсула сбора кандидатов: тонкий столбик в окне высот. Радиус чуть шире
  // креста подошвы, чтобы ни один из лучей не ушёл мимо собранного.
  const column = new Capsule(new THREE.Vector3(), new THREE.Vector3(), COLUMN_R)
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0))
  const tris: THREE.Triangle[] = []
  const _hit = new THREE.Vector3()
  const _n = new THREE.Vector3()
  const _tn = new THREE.Vector3()
  const floor = { y: 0, surface: 'mud' as Surface }

  /**
   * Кандидаты в пол: треугольники дерева, попавшие в окно высот под точкой.
   *
   * Собираем ОДИН раз на весь крест подошвы и капсулой, а не лучом. Луч у
   * `Octree` бесконечен: столбик из-под ног собрал бы заодно всё, что лежит
   * ниже поста до самого дна мира, и сортировка кандидатов стоила бы дороже
   * самой ходьбы. Капсула же ограничена ровно окном, которое просит ядро.
   */
  function gather(x: number, z: number, yFrom: number, probe: number): void {
    // Окно короче двух радиусов капсулой не описать - там она вырождается в
    // шар; сужаем её, а не окно.
    const r = Math.min(COLUMN_R, probe * 0.5)
    column.start.set(x, yFrom - probe + r, z)
    column.end.set(x, yFrom - r, z)
    column.radius = r
    tris.length = 0
    octree.getCapsuleTriangles(column, tris)
  }

  /**
   * Настил под точкой: ближайшая вниз грань из собранных, которая ещё
   * считается полом. Отвес перил и щёки марша отсеиваются по уклону, потолок -
   * сам собой: у него нормаль смотрит вниз.
   */
  function deckBelow(x: number, z: number, yFrom: number, probe: number): number | null {
    ray.origin.set(x, yFrom, z)
    let best: number | null = null
    for (const tri of tris) {
      // Без отсечения по обходу: сторону грани решает её нормаль, и та же
      // нормаль нужна нам для уклона.
      tri.getNormal(_tn)
      if (_tn.y < MIN_FLOOR_NY) continue
      if (!ray.intersectTriangle(tri.a, tri.b, tri.c, false, _hit)) continue
      const drop = yFrom - _hit.y
      if (drop < 0 || drop > probe) continue
      if (best === null || _hit.y > best) best = _hit.y
    }
    return best
  }

  /** Нормаль рельефа в точке: разность высот по двум осям, как у любого поля. */
  function groundNormal(x: number, z: number): THREE.Vector3 {
    const e = GROUND_EPS
    return _n
      .set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e))
      .normalize()
  }

  return {
    /**
     * Пол под точкой: выше из двух досягаемых - настил построек или земля.
     * Имя поверхности отсюда же уходит в шаги и приземление, и звук ждёт
     * ровно эту пару имён.
     */
    floorAt(x, z, yFrom, probe) {
      let y: number | null = null
      let surface: Surface = 'mud'

      // Настил: крестом, и берём САМУЮ ВЫСОКУЮ досягаемую точку подошвы.
      // Щель между плитами под одной точкой опору не роняет.
      gather(x, z, yFrom, probe)
      for (const [dx, dz] of FOOT_SAMPLES) {
        const h = deckBelow(x + dx, z + dz, yFrom, probe)
        if (h === null) continue
        if (y === null || h > y) {
          y = h
          surface = deckSurface(x + dx, h, z + dz)
        }
      }

      // Земля: досягаема шагом и не круче отвеса. Круче - не пол, и тело
      // пойдёт вниз (выталкивает такой склон `resolve`, см. ниже).
      const g = heightAt(x, z)
      if (g <= yFrom && g >= yFrom - probe && groundNormal(x, z).y >= MIN_FLOOR_NY) {
        if (y === null || g > y) {
          y = g
          // Лужа мельче сантиметра - это мокрая грязь, а не вода.
          surface = waterAt && waterAt(x, z) > 0.01 ? 'water' : 'mud'
        }
      }

      if (y === null) return null
      floor.y = y
      floor.surface = surface
      return floor
    },

    /**
     * Вытолкнуть тело из твёрдого. Правит `pos` на месте; скорость не трогаем -
     * ядро само отнимет ту её часть, что смотрит в поверхность, по суммарному
     * смещению за кадр.
     */
    resolve(pos, radius, height) {
      // Капсула от переступа до макушки: `[pos.y + STEP_UP, pos.y + height]`.
      // Ступень марша (подъём 0.19) под неё не попадает - её берёт `floorAt`.
      capsule.start.set(pos.x, pos.y + STEP_UP + radius, pos.z)
      capsule.end.set(pos.x, pos.y + height - radius, pos.z)
      capsule.radius = radius
      const hit = octree.capsuleIntersect(capsule)
      if (hit && hit.depth >= 1e-10) pos.addScaledVector(hit.normal, hit.depth)

      // Отвес рельефа. Пол его не держит (круче MIN_FLOOR_NY - не пол), а
      // держать надо: без этой пары строк шаг в сторону скалы уводил бы тело
      // ВНУТРЬ горы, где пола нет уже нигде, и мир кончался бы сбросом по
      // высоте падения. Выталкиваем по нормали, остаток тянет гравитация -
      // получается сползание вниз, а не подъём по стене.
      const depth = heightAt(pos.x, pos.z) - pos.y
      if (depth > 0) {
        const n = groundNormal(pos.x, pos.z)
        if (n.y < MIN_FLOOR_NY) pos.addScaledVector(n, depth * n.y)
      }
    },
  }
}
