import test from 'node:test'
import assert from 'node:assert/strict'

import { readLayer } from '../src/layer/read'

test('нет файлов - пустой слой, и он отвечает «нет», а не падает', () => {
  const layer = readLayer({})
  assert.equal(layer.present, false)
  assert.deepEqual(layer.names, [])
  assert.equal(layer.get('anything'), undefined)
})

test('файлы слоя именуются без каталога и расширения, по алфавиту', () => {
  const layer = readLayer({
    '../story/zeta.json': { n: 2 },
    '../story/alpha.json': { n: 1 },
  })
  assert.equal(layer.present, true)
  assert.deepEqual(layer.names, ['alpha', 'zeta'])
  assert.deepEqual(layer.get('alpha'), { n: 1 })
  assert.equal(layer.get('beta'), undefined)
})
