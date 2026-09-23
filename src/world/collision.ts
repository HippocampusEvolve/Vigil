/**
 * world/collision.ts — дерево коллизий, собираемое не одним куском.
 *
 * Перенесено из Winter Tower без изменений в логике. Числа в комментариях
 * ниже - замеры того мира: там дерево однажды держало главный поток
 * полторы секунды, и ради этого сборка и разложена на порции.
 *
 * Простая идея. Дерево коллизий — это указатель «где искать треугольники»,
 * и строится оно делением куба на восемь, пока в ячейке не останется мало
 * геометрии. Работа рекурсивная и на этом мире занимает полторы секунды: всё
 * это время главный поток занят, кадр не рисуется, а ответы сети не
 * разбираются — то есть три мегабайта карт стоят в очереди и ждут, пока мы
 * доделим кубики. Замер входа это и показал: бандл приезжает за 293 мс, потом
 * поток занят одной задачей на 1909 мс, и первая карта уходит в запрос только
 * на 2219-й миллисекунде.
 *
 * Здесь та же работа разложена на порции. Между порциями поток свободен:
 * браузер успевает нарисовать кадр, разобрать пришедшие карты и подвинуть
 * полосу загрузки.
 *
 * ДЕРЕВО ПРИ ЭТОМ ПОЛУЧАЕТСЯ РОВНО ТО ЖЕ, и это не пожелание, а требование.
 * `Octree.capsuleIntersect` не ищет ближайшее касание: он собирает
 * треугольники-кандидаты и выталкивает капсулу каждым по очереди, накапливая
 * сдвиг. Результат поэтому зависит и от набора кандидатов, и от их порядка.
 * Стоит изменить размер листа — в набор попадает больше дальней геометрии,
 * выталкиваний становится больше, и ходьба по миру меняется. Проверено
 * счётом (`npm run octree`): при листе в 64 треугольника вместо 8 ответы
 * расходятся на четверти проб, местами на два метра. Поэтому настройки дерева
 * оставлены заводскими, а меняется только то, КАК оно строится.
 *
 * Рекурсию для этого снимаем в очередь. Это возможно, потому что `split`
 * рекурсивен только по виду: узел сперва заводит все восемь ячеек,
 * раскладывает по ним свои треугольники и кладёт непустые к себе, и лишь
 * потом кому-то из них может понадобиться делиться дальше. Порядок, в котором
 * узел кладёт к себе детей, от момента их деления не зависит — значит деление
 * можно отложить. Тот же прогон это подтверждает: дерево совпадает узел в
 * узел, а ответы на 13 тысячах касаний не расходятся ни разу.
 *
 * Тонкости, на которых это легко сломать (обе стоили отдельного прогона):
 *
 *   - родитель ОПУСТОШАЕТ свой список, раздавая треугольники детям. Оставишь
 *     список на месте — и они окажутся сразу в двух местах, а запрос берёт их
 *     у первого же узла, где список непуст;
 *   - раздаёт он с конца (`pop`). От порядка в списке зависит порядок
 *     выталкивания капсулы, а оно некоммутативно.
 */

import * as THREE from 'three'
import { Octree } from 'three/examples/jsm/math/Octree.js'

/**
 * Сколько миллисекунд работаем, прежде чем уступить поток.
 *
 * Порция крупнее кадра намеренно. Пока дерево собирается, игрок стоит на
 * экране входа и мир за ним статичен — там летит только снег, и кадр раз в
 * тридцать миллисекунд его не портит. Зато накладные падают: на порциях по
 * двенадцать миллисекунд сборка растягивалась втрое против чистой работы, и
 * дерево доходило до готовности почти к четвёртой секунде — то есть позже,
 * чем человек успевает нажать «войти».
 */
const SLICE_MS = 24

// Общие временные объекты: узлов в мире сотни тысяч, и всё, что можно не
// создавать заново, создавать заново не стоит.
const _half = new THREE.Vector3()
const _offset = new THREE.Vector3()

/**
 * Разложить треугольники мешей в дерево, ничего не строя.
 *
 * Повторяет первую половину `fromGraphNode`. Она дешёвая — 18 мс на весь мир,
 * потому что работы тут ровно столько, сколько треугольников, — и режется по
 * мешам, но резать нечего.
 */
export function fillOctree(tree: Octree, group: THREE.Object3D): void {
  group.updateWorldMatrix(true, true)
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    if (!tree.layers.test(mesh.layers)) return
    const indexed = mesh.geometry.index !== null
    const geometry = indexed ? mesh.geometry.toNonIndexed() : mesh.geometry
    const pos = geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i += 3) {
      const v1 = new THREE.Vector3().fromBufferAttribute(pos, i)
      const v2 = new THREE.Vector3().fromBufferAttribute(pos, i + 1)
      const v3 = new THREE.Vector3().fromBufferAttribute(pos, i + 2)
      v1.applyMatrix4(mesh.matrixWorld)
      v2.applyMatrix4(mesh.matrixWorld)
      v3.applyMatrix4(mesh.matrixWorld)
      tree.addTriangle(new THREE.Triangle(v1, v2, v3))
    }
    if (indexed) geometry.dispose()
  })
}

/**
 * Разделить один узел на восемь ячеек. Повторяет тело `split` в точности,
 * но вместо рекурсии складывает работу в очередь.
 *
 * Экспортируется ради `npm run octree`: инструмент сверяет это дерево с тем,
 * что строит three, и обязан звать ровно то, что стоит в мире, а не копию.
 */
export function splitOnce(node: Octree, level: number, queue: [Octree, number][]): void {
  if (!node.box) return

  const half = _half.copy(node.box.max).sub(node.box.min).multiplyScalar(0.5)
  const cells: Octree[] = []
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      for (let z = 0; z < 2; z++) {
        const box = new THREE.Box3()
        // Смещение считаем в общий временный вектор: узлов в этом мире триста
        // тысяч, и восемь свежих `Vector3` на каждый — это два с половиной
        // миллиона объектов на ровном месте.
        box.min.copy(node.box.min).add(_offset.set(x, y, z).multiply(half))
        box.max.copy(box.min).add(half)
        cells.push(new Octree(box))
      }
    }
  }

  // `pop`, а не обход: родитель отдаёт треугольники детям и оставляет себе
  // пустой список, и отдаёт с конца. Подробности — в шапке файла.
  //
  // Перед честной проверкой стоит грубая — по габаритной коробке треугольника.
  // Она и съедала почти всё время: `intersectsTriangle` разделяет тела по
  // тринадцати осям, стоит сотни наносекунд, и звалась по восемь раз на каждый
  // разложенный треугольник — восемь с лишним миллионов раз за сборку. При
  // этом треугольник почти всегда лежит в одной-двух ячейках из восьми, и
  // остальные шесть отсекаются шестью сравнениями.
  //
  // На результат это не влияет по построению: если габариты не пересекаются,
  // то и тела не пересекаются — грубая проверка не может отвергнуть то, что
  // приняла бы честная. Порядок обхода ячеек прежний, значит и порядок
  // треугольников в списках прежний.
  let triangle
  while ((triangle = node.triangles.pop())) {
    const { a, b, c } = triangle
    const minX = Math.min(a.x, b.x, c.x)
    const maxX = Math.max(a.x, b.x, c.x)
    const minY = Math.min(a.y, b.y, c.y)
    const maxY = Math.max(a.y, b.y, c.y)
    const minZ = Math.min(a.z, b.z, c.z)
    const maxZ = Math.max(a.z, b.z, c.z)
    for (const cell of cells) {
      const box = cell.box!
      if (
        box.max.x < minX ||
        box.min.x > maxX ||
        box.max.y < minY ||
        box.min.y > maxY ||
        box.max.z < minZ ||
        box.min.z > maxZ
      )
        continue
      if (box.intersectsTriangle(triangle)) cell.triangles.push(triangle)
    }
  }

  for (const cell of cells) {
    const len = cell.triangles.length
    // Порог и предел глубины спрашиваем у родителя ровно так, как это делает
    // three: узлы рождаются с заводскими значениями, и на них стоит нынешняя
    // физика.
    if (len > node.trianglesPerLeaf && level < node.maxLevel) queue.push([cell, level + 1])
    if (len !== 0) node.subTrees.push(cell)
  }
}

/**
 * Собрать дерево очередью целиком, не уступая поток.
 *
 * То же дерево и тот же порядок, что у `buildCollision`, — просто без пауз.
 * Нужна дважды: ею доделывается остаток, если игрок вошёл раньше времени, и
 * ею же `npm run octree` сверяет результат с деревом three.
 */
export function buildCollisionSync(group: THREE.Object3D): Octree {
  const octree = new Octree()
  fillOctree(octree, group)
  octree.calcBox()
  const queue: [Octree, number][] = [[octree, 0]]
  let head = 0
  while (head < queue.length) {
    const [node, level] = queue[head++]
    splitOnce(node, level, queue)
  }
  return octree
}

export type Collision = {
  /** Дерево. Ссылка отдаётся сразу, наполняется по ходу дела. */
  octree: Octree
  /** Готово ли дерево целиком. До этого ходить по постройкам нельзя. */
  ready(): boolean
  /** Доля сделанного, 0..1 — для полосы загрузки. */
  progress(): number
  /** Доделать остаток разом. Зовётся, если игрок вошёл раньше времени. */
  finish(): void
}

/**
 * Собрать дерево порциями, уступая поток между ними.
 *
 * Треугольники раскладываются сразу и целиком: это дёшево, а деление без них
 * невозможно. Дальше очередь узлов разбирается по времени: работаем `SLICE_MS`
 * миллисекунд, отдаём поток, продолжаем.
 *
 * Уступаем через `MessageChannel`, а не `setTimeout`: у таймера минимальный
 * шаг в 4 мс, и на тысяче порций это лишние четыре секунды пустого ожидания.
 * И не через `requestAnimationFrame`: тот ждёт кадра, то есть 16 мс, и растянул
 * бы сборку впятеро — а нам нужно отдать поток, а не поспать.
 */
export function buildCollision(group: THREE.Object3D, onDone?: () => void): Collision {
  const octree = new Octree()
  fillOctree(octree, group)
  octree.calcBox()

  const queue: [Octree, number][] = [[octree, 0]]
  // Голова очереди — указателем, а не `shift()`: узлов в этом мире триста
  // тысяч, и сдвиг массива на каждом шаге превратил бы разбор в квадрат.
  // Стоило одного зависшего прогона.
  let head = 0
  let done = false
  // Оценка объёма работы для полосы: сколько узлов уже разобрано против того,
  // сколько их сейчас известно. Число растёт по ходу дела, поэтому доля
  // ползёт неравномерно — но она и нужна только чтобы полоса не стояла.
  let seen = 1

  const channel = new MessageChannel()
  channel.port1.onmessage = () => work()

  function step(): boolean {
    if (head >= queue.length) return false
    const [node, level] = queue[head++]
    splitOnce(node, level, queue)
    if (queue.length > seen) seen = queue.length
    return true
  }

  function complete(): void {
    if (done) return
    done = true
    channel.port1.onmessage = null
    onDone?.()
  }

  function work(): void {
    if (done) return
    const until = performance.now() + SLICE_MS
    do {
      if (!step()) {
        complete()
        return
      }
    } while (performance.now() < until)
    channel.port2.postMessage(0)
  }

  channel.port2.postMessage(0)

  return {
    octree,
    ready: () => done,
    progress: () => (done ? 1 : Math.min(head / Math.max(seen, 1), 0.99)),
    finish() {
      while (step());
      complete()
    },
  }
}
