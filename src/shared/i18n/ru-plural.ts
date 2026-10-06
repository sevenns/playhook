// Russian plural mirror. Russian has one/few/many/other; `tp` picks the form via Intl.PluralRules('ru-RU')
// (1 → one, 2–4 → few, 5–20 / 0 → many, fractions → other) and interpolates {n}. Full word forms are used
// here (the English source keeps compact "{n}h"/"{n}m" abbreviations) — so playtime reads "2 часа 15 минут".
import type { PluralKey, PluralForms } from './en-plural';

export const ruPlural: Partial<Record<PluralKey, PluralForms>> = {
  'format.hours': { one: '{n} час', few: '{n} часа', many: '{n} часов', other: '{n} часа' },
  'format.minutes': { one: '{n} минута', few: '{n} минуты', many: '{n} минут', other: '{n} минуты' },
  'drive.games': { one: '{n} игра', few: '{n} игры', many: '{n} игр', other: '{n} игры' },
  'notifications.unread': {
    one: '{n} непрочитанное уведомление',
    few: '{n} непрочитанных уведомления',
    many: '{n} непрочитанных уведомлений',
    other: '{n} непрочитанных уведомления',
  },
  'launcher.confirm.quitWithJobs': {
    one: 'Выполняется {n} операция, она будет отменена. Всё равно выйти?',
    few: 'Выполняются {n} операции, они будут отменены. Всё равно выйти?',
    many: 'Выполняется {n} операций, они будут отменены. Всё равно выйти?',
    other: 'Выполняется {n} операции, они будут отменены. Всё равно выйти?',
  },
  'launcher.confirm.shutdownWithJobs': {
    one: 'Выполняется {n} операция, она будет отменена. Всё равно выключить компьютер?',
    few: 'Выполняются {n} операции, они будут отменены. Всё равно выключить компьютер?',
    many: 'Выполняется {n} операций, они будут отменены. Всё равно выключить компьютер?',
    other: 'Выполняется {n} операции, они будут отменены. Всё равно выключить компьютер?',
  },
  'launcher.confirm.rebootWithJobs': {
    one: 'Выполняется {n} операция, она будет отменена. Всё равно перезагрузить компьютер?',
    few: 'Выполняются {n} операции, они будут отменены. Всё равно перезагрузить компьютер?',
    many: 'Выполняется {n} операций, они будут отменены. Всё равно перезагрузить компьютер?',
    other: 'Выполняется {n} операции, они будут отменены. Всё равно перезагрузить компьютер?',
  },
};
