import test from 'node:test'
import assert from 'node:assert/strict'

import { createBank, type BankName } from '../src/sound/bank'
import { LOOP_RMS } from '../src/sound/dsp'
import { defaultEar, edgePoint } from '../src/sound/outdoor'
import { falloff, panOf, qOf } from '../src/sound/place'
import { SPACES } from '../src/sound/reverb'
import { CLEARING, ENTRY_LAMP, WAKE_POINT } from '../src/world/layout'

const RATE = 48000

/** Петли, которые играются по кругу: у них не должно быть стыка. */
const LOOPS: BankName[] = ['leavesL', 'leavesR', 'concreteL', 'concreteR', 'curtain', 'stream', 'engine', 'brown', 'wander']

/** Счёт целиком, порциями по 4 мс, как из кадра. Возвращает самую долгую порцию. */
function bakeAll() {
  const bank = createBank(RATE)
  let worst = 0
  while (bank.pending > 0) {
    const t = performance.now()
    bank.work(4)
    worst = Math.max(worst, performance.now() - t)
  }
  return { bank, worst }
}

const first = bakeAll()
const bank = first.bank

test('счёт режется на порции: самая долгая не длиннее 30 мс', () => {
  // Время по часам скачет от нагрузки машины, поэтому три счёта и медиана.
  const worst = [first.worst, bakeAll().worst, bakeAll().worst].sort((a, b) => a - b)[1]
  assert.ok(worst <= 30, `самая долгая порция ${worst.toFixed(1)} мс`)
})

test('всё посчитано и конечно', () => {
  assert.equal(bank.pending, 0)
  for (const name of [...LOOPS, 'white', 'drops', 'irForest', 'irPost', 'irLower'] as BankName[]) {
    const data = bank.data(name)
    assert.ok(data && data.length > 0, `${name}: пусто`)
    for (const d of data) for (let i = 0; i < d.length; i++) assert.ok(Number.isFinite(d[i]), `${name}: не число на ${i}`)
  }
})

test('петли бесшовны: стык не больше обычного шага внутри петли', () => {
  for (const name of LOOPS) {
    for (const d of bank.data(name)!) {
      const steps = new Float64Array(d.length - 1)
      for (let i = 1; i < d.length; i++) steps[i - 1] = Math.abs(d[i] - d[i - 1])
      steps.sort()
      const usual = steps[Math.floor(steps.length * 0.999)]
      const seam = Math.abs(d[0] - d[d.length - 1])
      assert.ok(seam <= usual, `${name}: стык ${seam.toFixed(4)} при обычном шаге до ${usual.toFixed(4)}`)
    }
  }
})

test('петли приведены к общему уровню и без постоянной составляющей', () => {
  for (const name of ['leavesL', 'leavesR', 'concreteL', 'concreteR', 'curtain', 'stream', 'engine'] as BankName[]) {
    const d = bank.data(name)![0]
    let s = 0
    let q = 0
    for (let i = 0; i < d.length; i++) {
      s += d[i]
      q += d[i] * d[i]
    }
    const rms = Math.sqrt(q / d.length)
    assert.ok(Math.abs(rms - LOOP_RMS) < LOOP_RMS * 0.01, `${name}: RMS ${rms.toFixed(4)}`)
    assert.ok(Math.abs(s / d.length) < rms * 1e-3, `${name}: среднее ${(s / d.length).toExponential(2)}`)
  }
})

test('у дождя редкие крупные зёрна придавлены: пик не выше 12 дБ над RMS', () => {
  for (const name of ['leavesL', 'leavesR', 'concreteL', 'concreteR'] as BankName[]) {
    const d = bank.data(name)![0]
    let peak = 0
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
    // 4 RMS - потолок кривой; после неё уровень возвращается к RMS петли, отсюда запас в пару процентов.
    assert.ok(peak / LOOP_RMS <= 4.1, `${name}: пик ${(peak / LOOP_RMS).toFixed(2)} RMS`)
  }
})

test('левая и правая петли дождя разной длины: повтор не слышен', () => {
  assert.notEqual(bank.data('leavesL')![0].length, bank.data('leavesR')![0].length)
  assert.notEqual(bank.data('concreteL')![0].length, bank.data('concreteR')![0].length)
})

test('отклики: два канала, длина по таблице пространств, каналы разные', () => {
  for (const [name, kind] of [
    ['irForest', 'forest'],
    ['irPost', 'post'],
    ['irLower', 'lower'],
  ] as const) {
    const [l, r] = bank.data(name)!
    assert.equal(l.length, Math.floor(RATE * SPACES[kind].seconds))
    assert.equal(r.length, l.length)
    let same = 0
    for (let i = 0; i < l.length; i++) if (l[i] === r[i]) same++
    assert.ok(same < l.length * 0.01, `${name}: каналы совпадают`)
  }
})

test('закон расстояния: обратный, от опоры', () => {
  assert.equal(falloff(0.5, 1), 1)
  assert.equal(falloff(1, 1), 1)
  assert.equal(falloff(2, 1), 0.5)
  assert.equal(falloff(8, 2), 0.25)
})

test('панорама: справа от взгляда - вправо, слева - влево, впереди - посередине', () => {
  const ear = { x: 0, y: 1.6, z: 0, fx: 0, fy: 0, fz: -1 }
  assert.ok(panOf(ear, { x: 5, y: 0, z: 0 }) > 0.9)
  assert.ok(panOf(ear, { x: -5, y: 0, z: 0 }) < -0.9)
  assert.ok(Math.abs(panOf(ear, { x: 0, y: 0, z: -5 })) < 1e-9)
  // Совсем близкий источник к середине: вплотную панорама не мечется.
  assert.ok(Math.abs(panOf(ear, { x: 0.1, y: 0, z: 0 })) < 0.2)
})

test('добротность фильтров: у срезов - в децибелах, у полосовых - как есть', () => {
  assert.ok(Math.abs(qOf('lowpass', Math.SQRT1_2) + 3.01) < 0.01)
  assert.ok(Math.abs(qOf('highpass', 1) - 0) < 1e-12)
  assert.equal(qOf('bandpass', 3.5), 3.5)
})

test('опушка: точки у края поляны, с отступом внутрь или в лес', () => {
  let s = 1
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 200; i++) {
    const p = edgePoint(r, 2)
    const onEdgeX = Math.abs(p.x - (CLEARING.minX + 2)) < 1e-9 || Math.abs(p.x - (CLEARING.maxX - 2)) < 1e-9
    const onEdgeZ = Math.abs(p.z - (CLEARING.minZ + 2)) < 1e-9 || Math.abs(p.z - (CLEARING.maxZ - 2)) < 1e-9
    assert.ok((onEdgeX && p.z >= CLEARING.minZ && p.z <= CLEARING.maxZ) || (onEdgeZ && p.x >= CLEARING.minX && p.x <= CLEARING.maxX), `точка ${p.x}, ${p.z}`)
  }
})

test('ухо по умолчанию - на точке появления, взгляд на лампу', () => {
  const ear = defaultEar(WAKE_POINT, 1.62)
  assert.equal(ear.x, WAKE_POINT.x)
  assert.equal(ear.z, WAKE_POINT.z)
  assert.ok(Math.abs(Math.hypot(ear.fx, ear.fz) - 1) < 1e-9)
  // Лампа ровно впереди - панорама посередине.
  assert.ok(Math.abs(panOf(ear, { x: (ENTRY_LAMP.x0 + ENTRY_LAMP.x1) / 2, y: ENTRY_LAMP.y, z: ENTRY_LAMP.z })) < 1e-9)
})
