/**
 * Звук нутра на Node, без звуковой карты: затенение по графу зон, зона уха,
 * смесь пространств у дверей, порог, морзянка, мокрые подошвы, разовые звуки
 * в массив. Всё здесь - чистый счёт; как это звучит, меряет кит звука.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/sound/dsp'
import { crossedEntry, DOOR_IDS, earZone, hear, outward, shutDoors, sighStart, SIGH, spaceMix, type Doors } from '../src/sound/hear'
import { INDOOR, morse, TUBES } from '../src/sound/indoor'
import { LEVEL, SHADE } from '../src/sound/levels'
import { SPACE_TAU } from '../src/sound/mixer'
import { CREAK, DOOR_VOICE, GROAN, STEEL, renderCreak, renderGroan, renderLock, renderSlam, renderStarter, toPeak } from '../src/sound/strike'
import { Soles, SOLES } from '../src/sound/synth'
import { GENERATOR_ROOM } from '../src/world/layout'
import { FIXTURES, PORTALS, portalCenter, ROOMS, SOURCES, zoneAt } from '../src/world/zones'

const dB = (x: number) => 20 * Math.log10(x)
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

const gen = { rooms: [SOURCES.generator.room], at: SOURCES.generator, ref: LEVEL.generator.ref } as const

/** Точка на оси двери генераторной: источник в метре за дверью, ухо в метре перед ней. */
const genDoor = PORTALS.find((p) => p.door === 'gen')!
const c = portalCenter(genDoor)
const behind = { x: c.x, y: c.y, z: genDoor.z0 - 1 }
const before = { x: c.x, y: c.y, z: genDoor.z1 + 1 }
const probe = { rooms: ['C'] as const, at: behind, ref: 1 }

function doorsWith(id: keyof Doors, v: number): Doors {
  const d = shutDoors()
  d[id] = v
  return d
}

test('двери графа: все шесть створок', () => {
  assert.deepEqual([...DOOR_IDS].sort(), ['cold', 'entry', 'gen', 'hatch', 'inner', 'med'])
})

test('в той же зоне - полная полоса и закон расстояния до самого источника', () => {
  const ear = { x: SOURCES.generator.x, y: SOURCES.generator.y + 1.2, z: SOURCES.generator.z - 1.2 }
  assert.equal(zoneAt(ear.x, ear.y, ear.z), 'C')
  const h = hear(gen, ear, 'C', shutDoors())
  assert.equal(h.same, true)
  assert.equal(h.cutoff, Infinity)
  assert.ok(near(h.gain, LEVEL.generator.ref / Math.hypot(1.2, 1.2)))
})

test('через открытую дверь: потерь нет, срез 800-1500 Гц', () => {
  assert.equal(zoneAt(before.x, before.y, before.z), 'B')
  assert.equal(zoneAt(behind.x, behind.y, behind.z), 'C')
  const h = hear(probe, before, 'B', doorsWith('gen', 1))
  // Источник в метре от двери, ухо в метре от неё: закон расстояния ничего не отнимает.
  assert.ok(near(h.gain, 1, 1e-9), `усиление ${h.gain}`)
  assert.ok(h.cutoff >= 800 && h.cutoff <= 1500, `срез ${h.cutoff.toFixed(0)} Гц`)
})

test('через закрытую дверь: срез 200-400 Гц, потеря 12-20 дБ', () => {
  const h = hear(probe, before, 'B', shutDoors())
  const loss = -dB(h.gain)
  assert.ok(loss >= 12 - 1e-9 && loss <= 20, `потеря ${loss.toFixed(2)} дБ`)
  assert.ok(h.cutoff >= 200 && h.cutoff <= 400, `срез ${h.cutoff.toFixed(0)} Гц`)
})

test('доля открытия смешивает закрытую и открытую дверь', () => {
  let prevCut = 0
  let prevGain = 0
  for (const o of [0, 0.25, 0.5, 0.75, 1]) {
    const h = hear(probe, before, 'B', doorsWith('gen', o))
    assert.ok(h.cutoff > prevCut && h.gain > prevGain, `доля ${o}: срез ${h.cutoff.toFixed(0)}, усиление ${h.gain.toFixed(3)}`)
    prevCut = h.cutoff
    prevGain = h.gain
  }
})

test('генератор снаружи у стены: -12 дБ от своего уровня, срез стены', () => {
  const ear = { x: GENERATOR_ROOM.x1 + 1, y: SOURCES.generator.y, z: SOURCES.generator.z }
  assert.equal(zoneAt(ear.x, ear.y, ear.z), 'out')
  const h = hear(gen, ear, 'out', shutDoors())
  assert.ok(near(dB(h.gain), LEVEL.wall.db, 1e-6), `${dB(h.gain).toFixed(2)} дБ`)
  assert.ok(near(h.cutoff, SHADE.closed, 1e-3), `срез ${h.cutoff}`)
})

test('каждая закрытая дверь по пути отнимает ещё: из тамбура генератор тише, чем из коридора', () => {
  const inB = { x: 3, y: 1.6, z: -3.1 }
  const inA = { x: 3, y: 1.6, z: -1.2 }
  assert.equal(zoneAt(inB.x, inB.y, inB.z), 'B')
  assert.equal(zoneAt(inA.x, inA.y, inA.z), 'A')
  assert.ok(hear(gen, inA, 'A', shutDoors()).gain < hear(gen, inB, 'B', shutDoors()).gain)
})

test('улица в тамбуре - через закрытую входную дверь со срезом 1 кГц, дальше - как через стену', () => {
  const street = { rooms: ['out'] as const, ref: 1 }
  const inA = { x: 2.5, y: 1.6, z: -1.2 }
  assert.equal(zoneAt(inA.x, inA.y, inA.z), 'A')
  const a = hear(street, inA, 'A', shutDoors())
  assert.ok(near(a.cutoff, 1000, 1e-6), `срез в тамбуре ${a.cutoff.toFixed(0)} Гц`)
  assert.ok(-dB(a.gain) >= 12 - 1e-9 && -dB(a.gain) <= 20, `потеря ${(-dB(a.gain)).toFixed(1)} дБ`)
  const inB = { x: 3, y: 1.6, z: -3.1 }
  const b = hear(street, inB, 'B', shutDoors())
  assert.ok(b.cutoff <= 400, `срез в коридоре ${b.cutoff.toFixed(0)} Гц`)
  // Открытая входная: срез тот же, потери нет.
  const open = hear(street, inA, 'A', doorsWith('entry', 1))
  assert.ok(near(open.cutoff, 1000, 1e-6) && open.gain > a.gain * 3.9)
})

test('улица внизу почти не слышна: пять проёмов, три из них закрыты', () => {
  const r = ROOMS.I
  const ear = { x: (r.x0 + r.x1) / 2, y: r.floor + 1.6, z: (r.z0 + r.z1) / 2 }
  const h = hear({ rooms: ['out'], ref: 1 }, ear, 'I', shutDoors())
  assert.ok(dB(h.gain) < -30, `${dB(h.gain).toFixed(1)} дБ`)
})

test('дробь свода внизу - сквозь перекрытие или закрытый люк: тише не меньше чем на 12 дБ', () => {
  const r = ROOMS.I
  const ear = { x: (r.x0 + r.x1) / 2, y: r.floor + 1.6, z: (r.z0 + r.z1) / 2 }
  const vault = { rooms: ['E', 'F', 'G', 'H'] as const, ref: 1 }
  const h = hear(vault, ear, 'I', shutDoors())
  assert.ok(dB(h.gain) <= -12, `${dB(h.gain).toFixed(1)} дБ`)
  assert.ok(h.cutoff <= 400)
})

test('ухо в толще стены остаётся в своей комнате; за планом поста - снаружи', () => {
  const wall = { x: 3, y: 1.6, z: -3.87 }
  assert.equal(zoneAt(wall.x, wall.y, wall.z), 'out')
  assert.equal(earZone(wall, 'B'), 'B')
  assert.equal(earZone({ x: 3, y: 1.8, z: 2 }, 'A'), 'out')
  assert.equal(earZone({ x: 3, y: 1.6, z: -1.2 }, null), 'A')
})

test('улица изнутри ставится по уху за проёмом, снаружи поста', () => {
  const entry = PORTALS.find((p) => p.door === 'entry')!
  const e = outward(portalCenter(entry), { x: 2.5, y: 1.6, z: -1, fx: 0, fy: 0, fz: -1 })
  assert.equal(zoneAt(e.x, e.y, e.z), 'out')
  assert.ok(e.z > 0)
})

test('пространства: снаружи - лес, в комнатах - пост, у открытой входной двери слышно и соседнее', () => {
  const far = spaceMix({ x: -4, y: 1.6, z: 24 }, 'out', shutDoors())
  assert.deepEqual(far, { forest: 1, post: 0, lower: 0 })
  const inE = spaceMix({ x: -3.5, y: 1.6, z: -4 }, 'E', doorsWith('entry', 1))
  assert.equal(inE.post, 1)
  const closed = spaceMix({ x: 2.5, y: 1.9, z: 0.6 }, 'out', shutDoors())
  assert.equal(closed.post, 0)
  const open = spaceMix({ x: 2.5, y: 1.9, z: 0.6 }, 'out', doorsWith('entry', 1))
  assert.ok(open.post > 0 && open.forest > open.post, JSON.stringify(open))
  assert.ok(near(open.forest ** 2 + open.post ** 2, 1, 1e-9), 'доли сходятся по мощности')
  const lower = spaceMix({ x: -9.5, y: -1.6, z: -2 }, 'I', doorsWith('hatch', 1))
  assert.ok(lower.lower > lower.post && lower.post > 0, JSON.stringify(lower))
})

test('порог - событие только у входной двери', () => {
  assert.equal(crossedEntry('out', 'A'), true)
  assert.equal(crossedEntry('A', 'out'), true)
  assert.equal(crossedEntry('A', 'B'), false)
  assert.equal(crossedEntry('A', 'A'), false)
})

test('вздох ложится серединой в середину перехода пространств', () => {
  const now = 12.5
  const mid = sighStart(now) + SIGH.dur / 2
  // Экспонента с постоянной SPACE_TAU проходит полпути за SPACE_TAU * ln 2.
  assert.ok(near(1 - Math.exp(-(mid - now) / SPACE_TAU), 0.5, 1e-9))
})

test('морзянка: точка - единица, тире - три, паузы по правилам', () => {
  assert.deepEqual(morse('.-'), [
    [0, 1],
    [2, 5],
  ])
  assert.deepEqual(morse('. .'), [
    [0, 1],
    [4, 5],
  ])
  assert.deepEqual(morse('./.'), [
    [0, 1],
    [8, 9],
  ])
  assert.deepEqual(morse(''), [])
})

test('мокрые подошвы: 30 шагов по твёрдому, всё тише; грязь и вода мочат заново', () => {
  const s = new Soles()
  assert.equal(s.step('concrete'), 0)
  assert.equal(s.step('mud'), 0)
  let prev = Infinity
  for (let i = 0; i < SOLES; i++) {
    const k = s.step(i % 2 ? 'steel' : 'concrete')
    assert.ok(k > 0 && k < prev, `шаг ${i + 1}: ${k}`)
    prev = k
  }
  assert.equal(s.step('concrete'), 0)
  s.step('water')
  assert.equal(s.step('concrete'), 1)
})

test('гудят живые трубки и фитолампы; мёртвая молчит, накаливания нет', () => {
  for (const f of FIXTURES) {
    const humming = (f.kind === 'tube' || f.kind === 'phyto') && f.behavior !== 'dead'
    assert.equal(TUBES.includes(`tube:${f.id}`), humming, f.id)
  }
  for (const t of TUBES) assert.ok(INDOOR.includes(t))
})

test('разовые звуки в массив: пик ровно единица, всё конечно', () => {
  const rate = 48000
  const all = [
    renderCreak(rate, 1.2, false, DOOR_VOICE.entry, 1),
    renderLock(rate, DOOR_VOICE.entry, 2),
    renderSlam(rate, DOOR_VOICE.cold, 3),
    renderGroan(rate, 4),
    renderStarter(rate, 'click', 5),
    renderStarter(rate, 'tink', 6),
  ]
  for (const d of all) {
    let peak = 0
    for (let i = 0; i < d.length; i++) {
      assert.ok(Number.isFinite(d[i]))
      peak = Math.max(peak, Math.abs(d[i]))
    }
    assert.ok(near(peak, 1, 1e-6), `пик ${peak}`)
  }
  const flat = new Float32Array([0, 0.5, -2, 0.25])
  toPeak(flat)
  assert.ok(near(Math.max(...flat.map(Math.abs)), 1, 1e-6))
})

test('стон корпуса: моды в 40-200 Гц при любом разбросе, плавании и скорости проигрывания', () => {
  const low = GROAN.base[0] * (1 - GROAN.spread) * (1 - GROAN.drift) * GROAN.play[0]
  const high = GROAN.top * (1 + GROAN.drift) * GROAN.play[1]
  assert.ok(low >= 40, `нижняя мода ${low.toFixed(1)} Гц`)
  assert.ok(high <= 200, `верхняя мода ${high.toFixed(1)} Гц`)
  // И спад 2-5 с при любой скорости.
  assert.ok(GROAN.t60[0] / GROAN.play[0] >= 2 && GROAN.t60[1] / GROAN.play[0] <= 5)
  assert.ok(GROAN.t60[0] / GROAN.play[1] >= 2 && GROAN.t60[1] / GROAN.play[1] <= 5)
})

test('шаг по маршу: спад каждой моды 60-150 мс при любом разбросе и скорости шага', () => {
  for (const [, , t60] of STEEL.modes) {
    const slowest = (t60 * STEEL.spread[1]) / Math.min(STEEL.walk[0], STEEL.run[0])
    const fastest = (t60 * STEEL.spread[0]) / Math.max(STEEL.walk[1], STEEL.run[1])
    assert.ok(fastest >= 0.06 && slowest <= 0.15, `${(fastest * 1000).toFixed(0)}-${(slowest * 1000).toFixed(0)} мс`)
  }
})

test('скрип: медленная створка скрипит дольше быстрой, но в своих пределах', () => {
  const rate = 48000
  const slow = renderCreak(rate, 0.5, false, DOOR_VOICE.entry, 7).length / rate
  const fast = renderCreak(rate, 3, false, DOOR_VOICE.entry, 7).length / rate
  assert.ok(slow > fast)
  assert.ok(slow <= CREAK.length[1] + 0.25 && fast >= CREAK.length[0])
})

test('уровни нутра не громче событий: гул тише двери', () => {
  assert.ok(db(LEVEL.tube.db) < db(LEVEL.door.db))
  assert.ok(LEVEL.roof < LEVEL.rain)
})
