/**
 * layer/read.ts — разбор необязательного слоя данных мира.
 *
 * Простая идея, как с ключом от квартиры. Сама квартира - лес, пост, свет,
 * звук, тело и руки - стоит здесь, в коде мира. Слой данных - тексты,
 * расстановка, правила событий - лежит отдельно и приносится только на время
 * сборки: JSON-файлы в `src/story/`, которых нет в git этого репозитория.
 *
 * Мир обязан собираться и работать и без них. Нет файлов - пустой слой, и
 * всё, что от него зависит, просто молчит: никаких проверок на `null` по
 * всему миру, один объект с ответом «нет».
 *
 * Разбор отделён от чтения (`layer/index.ts`) намеренно: чтение делает Vite
 * при сборке, а разбор - обычная функция, и её можно проверить на Node.
 */

export interface Layer {
  /** Есть ли слой вообще. */
  readonly present: boolean
  /** Имена файлов слоя без каталога и расширения, по алфавиту. */
  readonly names: readonly string[]
  /** Содержимое файла по имени; нет такого файла - `undefined`. */
  get<T = unknown>(name: string): T | undefined
}

/**
 * Собрать слой из таблицы модулей: путь файла - его разобранный JSON.
 * Ровно в таком виде её отдаёт `import.meta.glob` с `import: 'default'`.
 */
export function readLayer(modules: Record<string, unknown>): Layer {
  const table = new Map<string, unknown>()
  for (const [path, data] of Object.entries(modules)) {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/i, '')
    table.set(name, data)
  }
  const names = Object.freeze([...table.keys()].sort())
  return {
    present: names.length > 0,
    names,
    get: <T>(name: string) => table.get(name) as T | undefined,
  }
}
