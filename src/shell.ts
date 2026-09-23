/**
 * shell.ts — оболочка мира: экран входа, он же пауза.
 *
 * Одинакова во всех мирах find-the-end.fun и переносится в новый мир копией
 * вместе с блоком «ОБОЛОЧКА МИРА» из `index.html` (docs/games.md). Правило
 * простое: здесь только вход, пауза и выход — ни настроек, ни счётчиков,
 * ни списка клавиш.
 *
 * Экран этот НЕ ЖДЁТ МИРА и не принадлежит ему. Он нарисован разметкой и виден
 * с первой секунды: титул, строка настроения и полоса загрузки. Кнопок до
 * готовности мира на нём нет вовсе — их прячет `body.booting`, и проступают
 * они вместе с расходящимся туманом, уже отзывчивыми. Мир собирается за
 * экраном и забирает управление им, когда встал на ноги.
 *
 * Выход на витрину кода не требует вовсе: и стрелка в углу, и тихая ссылка
 * под кнопкой — обычные `<a>` в разметке. Отсюда только класс `paused` на
 * `body`, по которому стрелка и появляется.
 */

export interface Shell {
  /**
   * Мир собран: экран переходит от `boot.js` к нему.
   *
   * Ничего не возвращает. Раньше отсюда приходило нажатие, сделанное до
   * готовности мира, — теперь его не бывает: кнопок до `unveil` на экране
   * нет, а значит нечего и держать в очереди.
   */
  ready(): void
  /** Показать экран: на каждой паузе. До первого входа он и так открыт. */
  open(): void
  /** Убрать экран: игрок в мире. */
  close(): void
  /** Открыт ли экран сейчас. */
  isOpen(): boolean
}

interface Boot {
  ready(handlers?: { enter?: (ev: Event) => void; reset?: () => void }): void
}

export function createShell(handlers: {
  onEnter: (ev: Event) => void
  onReset?: () => void
}): Shell {
  const gate = document.getElementById('gate')!
  const button = document.getElementById('enter') as HTMLButtonElement

  return {
    ready() {
      const boot = (window as Window & { __FTE_BOOT__?: Boot }).__FTE_BOOT__
      boot?.ready({ enter: handlers.onEnter, reset: handlers.onReset })
    },
    open() {
      gate.inert = false
      gate.setAttribute('aria-hidden', 'false')
      gate.classList.remove('hidden')
      document.body.classList.add('paused')
      requestAnimationFrame(() => button.focus({ preventScroll: true }))
    },
    close() {
      gate.classList.add('hidden')
      gate.inert = true
      gate.setAttribute('aria-hidden', 'true')
      document.body.classList.remove('paused')
      // После первого входа кнопка зовёт не в мир, а обратно в мир.
      const resume = button.dataset.resume
      if (resume) button.textContent = resume
      document.body.tabIndex = -1
      document.body.focus({ preventScroll: true })
    },
    isOpen() {
      return !gate.classList.contains('hidden')
    },
  }
}
