import test from 'node:test'
import assert from 'node:assert/strict'
import { Actions } from '../src/actions/state'
import { StepTrack, scheduleTape } from '../src/actions/tape'
import { projectedGlyph, projectedHeight } from '../src/actions/reading'

test('actions are gated and advance once per press', () => {
  const a = new Actions(true)
  assert.equal(a.verb('generator:lever'), null)
  assert.deepEqual(a.act('flashlight'), [{ kind: 'pick', id: 'flashlight' }])
  assert.deepEqual(a.act('flashlight'), [])
  assert.deepEqual(a.act('intercom'), [{ kind: 'use', id: 'intercom' }])
  assert.deepEqual(a.act('intercom'), [])
  assert.deepEqual(a.act('note:sample'), [{ kind: 'read:open', id: 'sample' }])
  assert.equal(a.pose, true)
  assert.equal(a.verb('journal'), null)
  assert.deepEqual(a.act('note:sample'), [{ kind: 'read:close', id: 'sample' }])
  assert.deepEqual(a.act('journal'), [{ kind: 'journal:open' }])
  for (let i = 1; i < 6; i++) assert.deepEqual(a.act('journal'), [{ kind: 'journal:page', value: i }])
  assert.deepEqual(a.act('journal'), [{ kind: 'journal:close' }])
  assert.deepEqual(a.act('console'), [{ kind: 'console:wear' }, { kind: 'channel', value: 1 }])
  assert.deepEqual(a.act('console'), [{ kind: 'channel', value: 2 }])
  a.act('console')
  assert.deepEqual(a.act('console'), [{ kind: 'channel', value: 4 }, { kind: 'tape:start' }])
  assert.deepEqual(a.finishTape(), [{ kind: 'tape:end' }])
  assert.deepEqual(a.finishTape(), [])
  a.leave()
  assert.deepEqual(a.act('generator:filler'), [{ kind: 'fuel' }])
  assert.deepEqual(a.act('generator:lever'), [{ kind: 'pull', value: 1 }])
  assert.deepEqual(a.act('generator:lever'), [{ kind: 'pull', value: 2 }])
  assert.deepEqual(a.act('generator:lever'), [{ kind: 'pull', value: 3 }, { kind: 'power:on' }])
  assert.deepEqual(a.act('generator:lever'), [])
  assert.equal(a.verb('wheel'), null)
  for (let i = 1; i <= 3; i++) assert.deepEqual(a.act('crate'), [{ kind: 'push', value: i }])
  assert.deepEqual(a.act('wheel'), [{ kind: 'open', id: 'wheel' }])
  assert.deepEqual(a.act('tarp'), [{ kind: 'remove', id: 'tarp' }])
  assert.deepEqual(a.act('climate:lever'), [{ kind: 'mode:auto' }])
  assert.deepEqual(a.act('pen'), [{ kind: 'write' }])
  assert.deepEqual(a.act('lamp:switch'), [{ kind: 'lamp:toggle', value: 0 }])
  assert.deepEqual(a.act('lamp:switch'), [{ kind: 'lamp:toggle', value: 1 }])
})

test('walking away puts down a held note and frees movement', () => {
  const a = new Actions(true)
  assert.deepEqual(a.act('note:N01'), [{ kind: 'read:open', id: 'N01' }])
  assert.equal(a.pose, true)
  assert.deepEqual(a.leave(), [{ kind: 'read:close', id: 'N01' }])
  assert.equal(a.pose, false)
  assert.equal(a.note, null)
  assert.deepEqual(a.leave(), [])
})

test('missing story keeps written actions and tape unavailable', () => {
  const a = new Actions(false)
  assert.equal(a.verb('note:x'), null)
  assert.equal(a.verb('journal'), null)
  assert.equal(a.verb('climate:lever'), null)
  assert.equal(a.verb('lamp:switch'), null)
  for (let i = 0; i < 4; i++) a.act('console')
  assert.equal(a.tapePlayed, false)
})

test('recorded steps retain coordinates and replay with compressed silence', () => {
  const track = new StepTrack()
  track.record(100, 1, 2, 'mud', false)
  track.record(110, 5, 8, 'concrete', true)
  track.record(111, 6, 9, 'steel', false)
  const cues = scheduleTape(track.snapshot())
  const own = cues.filter((cue) => cue.kind === 'step').slice(18)
  assert.deepEqual(own.map((cue) => [cue.at, cue.step?.x, cue.step?.z, cue.step?.surface]), [
    [50.5, 1, 2, 'mud'], [52, 5, 8, 'concrete'], [53, 6, 9, 'steel'],
  ])
  assert.equal(cues.find((cue) => cue.kind === 'bell')?.at, 53.7)
  assert.equal(cues.at(-1)?.kind, 'stop')
})

test('held-paper projection preserves a 14 CSS px lowercase glyph at 360 x 640', () => {
  // 0.021 m glyph at 0.45 m from a 70 degree camera.
  assert.ok(projectedHeight(640, 70, 0.45, 0.021) >= 14)
  assert.ok(projectedGlyph(640, 640 * 0.68, 16) >= 14)
})
