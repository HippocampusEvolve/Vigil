/**
 * asset.ts — штамп версии в адресе каждого файла из `public/`.
 *
 * Модели и текстуры попадают в сборку под своими именами, без хэша: у бандла
 * Vite имя меняется вместе с содержимым, у карты камня — нет. А nginx отдаёт
 * их с `Cache-Control: immutable` на год, и immutable означает не «храни
 * подольше», а «даже не переспрашивай». Вернувшийся игрок ещё год видит ту
 * версию, что скачал в первый раз, и выкладка этого не меняет: адрес прежний.
 *
 * Ловушка не теоретическая. В соседнем мире модель камина так и простояла
 * целую выкладку — на сервере новая, в браузере старая, и по картинке не
 * отличить.
 *
 * Штамп — восемь знаков хэша содержимого, их считает плагин в vite.config.js
 * при сборке. Адрес становится ключом браузерного кэша: правка одного файла
 * обновляет ровно его, остальные остаются скачанными. В dev таблица пустая.
 *
 * Перехватчик один на всё. Модели и карты идут через общий
 * `DefaultLoadingManager` (см. gltfload.ts и world/materials.ts), и он видит
 * каждый адрес, который three.js собирается запросить, — включая те, что
 * загрузчик собирает сам из относительных путей внутри `.gltf`.
 */

import { DefaultLoadingManager } from 'three'
import stamps from 'virtual:asset-stamps'

const BASE = import.meta.env.BASE_URL

const key = (url: string) =>
  (url.startsWith(BASE) ? url.slice(BASE.length) : url.replace(/^\//, '')).split('?')[0]

export function stampUrl(url: string): string {
  if (typeof url !== 'string' || url.startsWith('data:') || url.startsWith('blob:')) return url
  const stamp = stamps[key(url)]
  if (!stamp || /[?&]v=/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}v=${stamp}`
}

/** Адрес файла из `public/` со штампом. Пути в мире относительные, поэтому
 *  почти всё идёт через перехватчик; эта функция — для тех мест, где адрес
 *  строится в обход three.js. */
export const asset = (path: string) => stampUrl(BASE + path.replace(/^\//, ''))

DefaultLoadingManager.setURLModifier(stampUrl)
