/**
 * Виртуальный модуль со штампами версий: его собирает плагин из
 * vite.config.js, на диске такого файла нет. Ключ — путь файла относительно
 * `public/`, значение — восемь знаков хэша содержимого.
 */
declare module 'virtual:asset-stamps' {
  const stamps: Record<string, string | undefined>
  export default stamps
}
