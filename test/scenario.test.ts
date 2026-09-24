import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Scenario, type Script } from '../src/scenario/engine'
import { TensionDirector } from '../src/scenario/director'
import { FlagJournal } from '../src/scenario/journal'

const sample: Script = {
  flags: { ready: 1, done: 2 },
  rules: [
    { id: 'start', when: { event: 'pick:item' }, do: [['flag', 'ready'], ['tension', 0.8]] },
    { id: 'finish', when: { event: 'use:door', all: ['ready'] }, after: 4, do: [['flag', 'done']] },
  ],
}

test('executor gates, schedules and deduplicates independent neutral events', () => {
  const fired: string[] = []
  const scene = new Scenario(sample, [], (e) => fired.push(e.id))
  scene.emit('use:door')
  scene.update(10)
  assert.deepEqual(fired, [])
  scene.emit('pick:item')
  scene.emit('use:door')
  scene.emit('use:door')
  scene.update(3.999)
  assert.deepEqual(fired, ['start'])
  scene.update(0.001)
  assert.deepEqual(fired, ['start', 'finish'])
  assert(scene.has('done'))
  scene.emit('use:door')
  assert.equal(fired.length, 2)
})

test('director rises in two seconds, falls in six, and clamps targets', () => {
  const d = new TensionDirector()
  d.set(2)
  assert.equal(d.update(1), 0.625)
  assert.equal(d.update(1), 1)
  assert.equal(d.heart, 1)
  d.set(-2)
  assert.equal(d.update(3), 0.5)
  assert.equal(d.update(3), 0)
})

test('journal stores one fixed record per flag and restores it', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const journal = new FlagJournal('flags', storage)
  assert(journal.put(2, 1234))
  assert(!journal.put(2, 4567))
  assert.equal(atob(values.get('flags')!).length, 16)
  assert.deepEqual(new FlagJournal('flags', storage).numbers(), [2])
})
