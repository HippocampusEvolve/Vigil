/**
 * layer/index.ts — чтение слоя данных мира при сборке.
 *
 * Vite собирает сюда все JSON из `src/story/`, если каталог есть, и пустую
 * таблицу, если его нет: сборка от этого не падает. Разбор - в `read.ts`.
 */

import { readLayer } from './read'

export type { Layer } from './read'

export const layer = readLayer(import.meta.glob('../story/*.json', { eager: true, import: 'default' }))
