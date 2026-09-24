/**
 * touch.ts — управление пальцем этого мира.
 *
 * Сам слой живёт в ядре (`world-core/core`, `TouchControls`): пальцы, оси,
 * поворот взгляда, кнопки как элементы, пропуск касаний по экранам оболочки.
 * Здесь остаётся только то, что про этот мир: кнопка одна.
 *
 * Палец на ЛЕВОЙ половине экрана ведёт тело, на ПРАВОЙ поворачивает взгляд.
 * Кнопка «рука» появляется, только когда ею есть что сделать. Других кнопок
 * нет: прыжка на таче нет вовсе, всё, что делается клавиатурой, делается
 * этой рукой.
 */

import { TouchControls, touchForced, touchSupported } from 'world-core/core'
import type { Input, SmoothLook } from 'world-core/core'

export { touchForced, touchSupported }

/** Иконка: только штрих, без заливок и подложек. */
const ICONS = {
  // рука-действие: точка в кольце - «тронуть то, что перед тобой»
  act: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="0.8"/>',
} as const

export type Touch = ReturnType<typeof createTouch>

export function createTouch(input: Input, look: SmoothLook) {
  const touch = new TouchControls({
    input,
    look,
    // касание кнопок оболочки (экран входа, пауза, выход на витрину) не
    // глушим - иначе до `click` дело не дойдёт и из мира будет не выйти
    passThrough: 'button, a, #gate, #read-card, #read-card *',
    buttons: [
      { id: 'tbAct', label: 'Действие', icon: ICONS.act, press: (down) => down && input.pressAction() },
    ],
  })

  // Что уже стоит в DOM: трогать разметку каждый кадр, чтобы оставить её той
  // же самой, незачем.
  let shownAction: boolean | undefined

  return {
    get active() {
      return touch.active
    },

    /** Войти в мир: pointer lock тут не нужен, просто включаемся. */
    activate: () => touch.activate(),

    /** Видимость «руки» - из кадра: есть ли перед игроком что-то, что можно тронуть. */
    setAction(action: boolean) {
      if (action === shownAction) return
      shownAction = action
      touch.show('tbAct', action)
    },
  }
}
