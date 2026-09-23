/**
 * offline.ts — подключение service worker'а мира.
 *
 * Одинаково во всех мирах find-the-end.fun и переносится в новый мир копией
 * вместе с `sw-template.js` и плагином `serviceWorker()` из vite.config.
 *
 * Зовётся ПОСЛЕ того, как мир запущен: worker нужен следующему приходу, а не
 * этому, и лезть с ним в загрузку, которую мы только что расшили, было бы
 * смешно. Установка тянет оболочку заново, и пусть она тянется тогда, когда
 * канал уже свободен.
 *
 * `?nosw` снимает worker'а и чистит его кэши. Это не игроцкая ручка, а
 * лекарство: закэшированная оболочка переживает обычный F5, и когда мир
 * ведёт себя не так, как лежит на сервере, первым делом нужно уметь
 * вернуться на голую сеть.
 */

export function keepOffline() {
  if (!('serviceWorker' in navigator)) return;

  if (new URLSearchParams(location.search).has('nosw')) {
    const base = import.meta.env.BASE_URL;
    const scope = new URL(base, location.href).href;
    const suffix = base.replace(/\//g, '-');
    navigator.serviceWorker.getRegistrations()
      .then(rs => Promise.all(rs.filter(r => r.scope === scope).map(r => r.unregister())))
      .catch(e => console.warn('worker не отключён:', e));
    if (self.caches) caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith(`fte-shell${suffix}`) || k === `fte-assets${suffix}`).map(k => caches.delete(k))))
      .catch(e => console.warn('кэш мира не очищен:', e));
    return;
  }

  // В dev файла нет вовсе: worker закэшировал бы dev-сервер, и правка
  // переставала бы доезжать до браузера (см. плагин в vite.config.js).
  if (import.meta.env.DEV) return;

  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .catch((e: unknown) => console.warn('worker не встал:', e));
}
