// Константы интеграции с Битрикс24: права, встройки, события, настройки SDK. Одно место — чтобы
// установка, документация (docs/B24_EVENTS.md, docs/REST_METHODS.md) и код не разъехались.

import type { RestrictionParams } from '@bitrix24/b24jssdk'

/**
 * Права (scope) приложения — задаются в карточке приложения в портале.
 * ⚠ Право задач называется `task`, хотя страницы tasks.task.* в документации пишут `tasks`:
 * документация противоречит сама себе, а живой портал принял `task` (замер соседнего
 * get-task-from-b24 от 2026-08-26, их docs/CLIENT_APP.md). Страница установки сверяет список
 * с методом `scope` и показывает, чего не хватает.
 */
export const B24_REQUIRED_SCOPES = ['crm', 'task', 'catalog', 'user_brief', 'placement'] as const

/** Встройка: пункт меню верхней кнопки карточки нового счёта (документация CRM_XXX_DETAIL_TOOLBAR). */
export const INVOICE_PLACEMENT = 'CRM_SMART_INVOICE_DETAIL_TOOLBAR'
export const INVOICE_PLACEMENT_TITLE = 'Заполнить из задач'

/** Путь страницы-обработчика встройки. */
export const INVOICE_HANDLER_PATH = '/invoice'

/** События, на которые подписываемся при установке (обработчик — /api/b24/events). */
export const BOUND_EVENTS = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const
export const EVENTS_HANDLER_PATH = '/api/b24/events'

/**
 * Настройки SDK для всего фрейма (`initializeB24Frame`, useB24.ts): без автоматических повторов
 * при сетевой ошибке, таймауте и ответе 5xx. Приложение пишет в портал то, что повторять нельзя:
 * `crm.item.productrow.add`, `crm.activity.configurable.add`, `placement.bind` — повтор даёт дубли, а
 * запрос, выполненный порталом с опоздавшим ответом, SDK по умолчанию отправил бы ещё раз
 * (`retryOnNetworkError`, до 3 попыток — код b24jssdk 2.2.0; находка /code-review).
 * Отказы по лимитам портала (429, QUERY_LIMIT_EXCEEDED) SDK по-прежнему пережидает и повторяет:
 * такой запрос портал не выполнял. Цена — чтение при сетевом сбое само не повторяется, сотрудник
 * повторит его кнопкой. Задаётся один раз при создании фрейма: переключение на каждую запись
 * портило настройки ограничителя SDK (он запоминает их как исходные) и было гонкой.
 */
export function sdkRestrictionParams(): Partial<RestrictionParams> {
  return {
    retryOnNetworkError: false,
    // ERR_BAD_RESPONSE — так axios помечает ответ 5xx; без него SDK счёл бы ответ временным сбоем.
    hardErrorCodes: ['ERR_BAD_RESPONSE']
  }
}
