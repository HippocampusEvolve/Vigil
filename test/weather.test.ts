/**
 * Молнии на Node: расписание и огибающая против правила фоточувствительности
 * (look.md): не больше трёх вспышек в секунду и ни одной пары молний ближе
 * трёх секунд. Вспышкой считается подъём огибающей через 0.1 - перепад такой
 * силы уже больше десяти процентов яркости кадра, с запасом.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createLightning, createSchedule, envelope, INTERVAL, NEAR_MAX, strokeLength } from '../src/weather/lightning'

const FRAME = 1 / 60
const HOURS = 6

test('первая молния не раньше 45 с, пары не ближе 3 с, близких не больше двух', () => {
  for (const seed of [1, 7, 3312, 99991]) {
    const s = createSchedule(seed)
    let prev = s.next()
    assert.ok(prev.at >= INTERVAL.min, `первая на ${prev.at.toFixed(1)} с`)
    let near = prev.near ? 1 : 0
    while (prev.at < HOURS * 3600) {
      const cur = s.next()
      assert.ok(cur.at - prev.at >= 3, `две молнии через ${(cur.at - prev.at).toFixed(2)} с`)
      assert.ok(cur.at - (prev.at + strokeLength(prev)) > 0, 'разряд начался, пока шёл прошлый')
      if (cur.near) near++
      prev = cur
    }
    assert.ok(near <= NEAR_MAX, `близких ударов ${near}`)
  }
})

test('вспышек не больше трёх в секунду на всём протяжении', () => {
  const flashes: number[] = []
  const lightning = createLightning(3312)
  let t = 0
  let above = false
  // Шесть часов кадрами по 1/60 с: и лидер, и обратный удар видны кадрам.
  while (t < HOURS * 3600) {
    const f = lightning.update(FRAME)
    t += FRAME
    if (!above && f > 0.1) {
      above = true
      flashes.push(t)
    } else if (above && f < 0.05) {
      above = false
    }
  }
  assert.ok(flashes.length > 0, 'за шесть часов не было ни одной вспышки')
  let worst = 0
  for (let i = 0, j = 0; i < flashes.length; i++) {
    while (flashes[i] - flashes[j] >= 1) j++
    worst = Math.max(worst, i - j + 1)
  }
  assert.ok(worst <= 3, `в одной секунде ${worst} вспышек`)
})

test('огибающая: лидер слабее обратного удара, в паузе темно, хвост гаснет', () => {
  const s = createSchedule(5).next()
  const mid = (a: number, b: number) => (a + b) / 2
  const leader = envelope(s, mid(0.02, s.leader - 0.02))
  const pause = envelope(s, s.leader + s.pause / 2)
  const ret = envelope(s, s.leader + s.pause + 0.03)
  const tail = envelope(s, strokeLength(s) + 0.1)
  assert.ok(leader > 0.3 && leader <= 0.5, `лидер ${leader}`)
  assert.equal(pause, 0)
  assert.ok(ret > leader, `обратный удар ${ret} против лидера ${leader}`)
  assert.equal(tail, 0)
})
