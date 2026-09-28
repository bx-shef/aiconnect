// Константы интеграции с Битрикс24: права, события, настройки SDK. Одно место — чтобы
// установка, документация (docs/B24_EVENTS.md, docs/REST_METHODS.md) и код не разъехались.

import type { RestrictionParams } from '@bitrix24/b24jssdk'

/**
 * Права (scope) приложения — задаются в карточке приложения в портале.
 * `ai_admin` — `ai.engine.register` / `unregister` / `list` (документация метода, «Scope: ai_admin»);
 * `user_brief` — `user.current` и минимальные данные сотрудников (статья «Доступные скоупы
 * Битрикс24»). `profile`, `scope`, `app.info` — «Scope: базовый» в документации; у `event.bind` /
 * `event.get` / `event.unbind` страница MCP скоуп не называет — шаблон вызывал их с тем же набором
 * без отдельного права (подтвердить установкой на тестовом портале). Страница установки сверяет список с методом `scope` и показывает, чего не хватает.
 */
export const B24_REQUIRED_SCOPES = ['ai_admin', 'user_brief'] as const

/** События, на которые подписываемся при установке (обработчик — /api/b24/events). */
export const BOUND_EVENTS = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const
export const EVENTS_HANDLER_PATH = '/api/b24/events'

/**
 * Настройки SDK для всего фрейма (`initializeB24Frame`, useB24.ts): без автоматических повторов
 * при сетевой ошибке, таймауте и ответе 5xx. Приложение пишет в портал то, что повторять нельзя
 * (`event.bind`, дальше — `ai.engine.register`): запрос, выполненный порталом с опоздавшим ответом,
 * SDK по умолчанию отправил бы ещё раз (`retryOnNetworkError`, до 3 попыток — код b24jssdk 2.2.0).
 * Отказы по лимитам портала (429, QUERY_LIMIT_EXCEEDED) SDK по-прежнему пережидает и повторяет:
 * такой запрос портал не выполнял. Задаётся один раз при создании фрейма: переключение на каждую
 * запись портило настройки ограничителя SDK (он запоминает их как исходные) и было гонкой.
 */
export function sdkRestrictionParams(): Partial<RestrictionParams> {
  return {
    retryOnNetworkError: false,
    // ERR_BAD_RESPONSE — так axios помечает ответ 5xx; без него SDK счёл бы ответ временным сбоем.
    hardErrorCodes: ['ERR_BAD_RESPONSE']
  }
}
