import test from 'node:test'
import assert from 'node:assert/strict'

import { createAwakening } from '../src/awaken'
import type { Look } from '../src/look'

const EYE_FROM = 0.3
const EYE_TO = 1.62
const YAW = -0.27
const PITCH = 0.04

/** Мир-заглушка: запоминает, что пробуждение сделало с туманом, светом, взглядом и глазом. */
function world(ready = () => true) {
  const state = { fog: NaN, dark: NaN, light: NaN, sound: NaN, yaw: NaN, pitch: NaN, eye: NaN }
  const eyes: number[] = []
  const look = {
    setYaw(yaw: number, pitch = 0) {
      state.yaw = yaw
      state.pitch = pitch
    },
  } as unknown as Look
  const awakening = createAwakening({
    setVeil: (v, d) => {
      state.fog = v
      state.dark = d
    },
    setLight: (v) => (state.light = v),
    setSound: (v) => (state.sound = v),
    look,
    yaw: YAW,
    pitch: PITCH,
    eye: { from: EYE_FROM, to: EYE_TO },
    setEye: (h) => {
      state.eye = h
      eyes.push(h)
    },
    ready,
  })
  /** Прокрутить n секунд кадрами по 1/60, как это делает цикл мира. */
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) awakening.update(1 / 60)
  }
  return { awakening, state, eyes, run }
}

test('глаз начинает у земли и стоит там до нажатия', () => {
  const w = world()
  assert.equal(w.state.eye, EYE_FROM)
  w.awakening.reveal()
  w.run(3)
  assert.equal(w.state.eye, EYE_FROM, 'за титулом игрок ещё лежит')
  assert.ok(w.awakening.holds())
})

test('после нажатия глаз встаёт на рост, взгляд находит цель, управление отдаётся', () => {
  const w = world()
  w.awakening.reveal()
  w.run(2)
  assert.equal(w.awakening.enter(), true)
  w.run(3)
  assert.equal(w.awakening.holds(), false)
  assert.equal(w.state.eye, EYE_TO)
  assert.equal(w.state.yaw, YAW)
  assert.equal(w.state.pitch, PITCH)
  assert.equal(w.state.fog, 1)
  assert.equal(w.state.dark, 0)
  assert.equal(w.state.light, 1)
  assert.equal(w.state.sound, 1)
})

test('подъём идёт без рывков: глаз не опускается и не прыгает', () => {
  const w = world()
  w.awakening.reveal()
  w.run(2)
  const from = w.eyes.length
  w.awakening.enter()
  w.run(3)
  const rise = w.eyes.slice(from)
  let worst = 0
  for (let i = 1; i < rise.length; i++) {
    assert.ok(rise[i] >= rise[i - 1] - 1e-12, `глаз опустился на кадре ${i}`)
    worst = Math.max(worst, rise[i] - rise[i - 1])
  }
  // Полтора метра за 2.6 с с плавным ходом: самый быстрый кадр - доли
  // сантиметра на сантиметры, а не скачок.
  assert.ok(worst < 0.03, `самый большой шаг глаза за кадр ${worst.toFixed(3)} м`)
})

test('вход из полной темноты тоже доводит подъём до конца', () => {
  const w = world()
  assert.equal(w.awakening.enter(), true)
  w.run(3)
  assert.equal(w.awakening.holds(), false)
  assert.equal(w.state.eye, EYE_TO)
})

test('неготовый мир держит пелену, но глаз уже на росте; готовность отпускает сразу', () => {
  let ready = false
  const w = world(() => ready)
  w.awakening.reveal()
  w.run(2)
  w.awakening.enter()
  w.run(5)
  assert.equal(w.awakening.holds(), true, 'в недособранный мир не пускаем')
  assert.equal(w.state.eye, EYE_TO)
  ready = true
  w.run(1 / 60)
  assert.equal(w.awakening.holds(), false)
})

test('повторное нажатие подъём не перезапускает', () => {
  const w = world()
  w.awakening.reveal()
  w.run(2)
  assert.equal(w.awakening.enter(), true)
  w.run(1)
  const mid = w.state.eye
  assert.equal(w.awakening.enter(), false)
  w.run(1 / 60)
  assert.ok(w.state.eye >= mid, 'второе нажатие не должно ронять игрока обратно в грязь')
})
