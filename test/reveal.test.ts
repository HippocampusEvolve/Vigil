import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BeaconClock, decode, encode } from '../src/reveal/morse'
import { clearState } from '../src/reveal/transition'
import { afterEnding, dayNumber, loadVisit, returnMode } from '../src/reveal/visit'

test('Morse round trip and observed reply', () => {
  const call = encode('СОС 2', 0.35)
  const reply = encode('ТЕСТ', 0.35)
  assert.equal(decode(call, 0.35), 'СОС 2')
  assert.equal(decode(reply, 0.35), 'ТЕСТ')
  const beacon = new BeaconClock(call, reply)
  beacon.setCall()
  assert.equal(beacon.state, 'call')
  beacon.reply()
  assert.equal(beacon.update(2.99, true).light, 0)
  beacon.update(0.01, true)
  const length = reply.reduce((n, p) => n + p.duration, 0)
  assert.equal(beacon.update(length / 2, false).completed, false)
  assert.equal(beacon.update(length / 2, true).completed, false)
  assert.equal(beacon.update(7 * 0.35, true).completed, false)
  assert.equal(beacon.update(length - 0.01, true).completed, false)
  assert.equal(beacon.update(0.01, true).completed, true)
  assert.equal(beacon.state, 'steady')
})

test('clear transition has no flash-sized brightness step', () => {
  let previous = clearState(0)
  let previousBrightness = 0.015 + previous.sky * 0.03 + previous.rain * 0.002
  let largeFlashes = 0
  for (let frame = 1; frame <= 40 * 60; frame++) {
    const current = clearState(frame / 60)
    for (const channel of ['rain', 'sky', 'fog'] as const) {
      assert(Math.abs(current[channel] - previous[channel]) < 0.01, `${channel}: frame ${frame}`)
    }
    assert(current.rain <= previous.rain)
    assert(current.sky >= previous.sky)
    const brightness = 0.015 + current.sky * 0.03 + current.rain * 0.002
    if (Math.abs(brightness - previousBrightness) / previousBrightness > 0.1) largeFlashes++
    previousBrightness = brightness
    previous = current
  }
  assert.equal(largeFlashes, 0)
  assert.equal(previous.rain, 0)
  assert.equal(previous.sky, 1)
  assert.equal(previous.fog, 0.004)
})

test('dated returns after both endings and interrupted visit', () => {
  const release = '2026-09-24'
  const start = Date.parse(`${release}T00:00:00Z`)
  assert.equal(dayNumber(release, 11312, start), 11312)
  assert.equal(dayNumber(release, 11312, start + 3 * 86400000), 11315)
  const map = new Map<string, string>()
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) } }
  const visits = loadVisit(storage)
  assert.equal(returnMode(visits.state), 'new')
  visits.save({ ...visits.state, position: [1, 2, 3], yaw: 0.4, pitch: 0.2, weatherSeconds: 9 })
  assert.equal(returnMode(loadVisit(storage).state), 'resume')
  assert.equal(loadVisit(storage).state.weatherSeconds, 9)
  visits.save(afterEnding(visits.state, 'a', start + 86400000))
  assert.equal(returnMode(loadVisit(storage).state), 'again')
  assert.deepEqual(loadVisit(storage).state.arrivals, [start + 86400000])
  assert.equal(dayNumber(release, 11312, loadVisit(storage).state.endedAt), 11313)
  visits.save(afterEnding(visits.state, 'b', start + 2 * 86400000))
  assert.equal(returnMode(loadVisit(storage).state), 'epilogue')
  assert.equal(loadVisit(storage).state.visits, 2)
  assert.equal(dayNumber(release, 11312, loadVisit(storage).state.endedAt), 11314)
})
