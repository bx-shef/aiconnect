// REST от имени администратора-установщика (сохранённые токены). Две ловушки (находка /code-review):
//  1) запись о портале, которую несёт проверенный фрейм-пользователь, взята из кэша проверки и
//     живёт минуту — после рефреша там СТАРЫЕ токены, а refresh-токен одноразовый (ротация):
//     второе сохранение ставок за минуту упало бы на invalid_grant. Поэтому каждый вызов
//     читает запись о портале заново;
//  2) два одновременных вызова с просроченным access-токеном оба пошли бы рефрешить одним и тем же
//     refresh-токеном — выиграл бы один. Поэтому вызовы одного портала выполняются по очереди.
// Очередь — в памяти процесса: сервер один (docs/ARCHITECTURE.md).
//  3) очередь не ждёт вечно: вызов, который не завершился за {@link INSTALLER_CALL_TIMEOUT_MS},
//     отклоняется, и очередь идёт дальше — иначе один зависший запрос к серверу авторизации (у SDK
//     на продление токена нет таймаута) блокировал бы запись ставок портала до перезапуска
//     (находка /code-review).

import type { RestCall } from './b24Client'
import { getPortal, type KeyValue, type PortalRecord } from './tokenStore'

/** Сколько ждать вызов токеном установщика; дольше — ошибка, и очередь портала идёт дальше. */
export const INSTALLER_CALL_TIMEOUT_MS = 60_000

const queues = new Map<string, Promise<void>>()

/** `p` или отказ по истечении `ms`; таймер не держит процесс. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`installer call timed out after ${ms} ms`)), ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Выполняет `fn` после всех ранее начатых вызовов с тем же ключом. Ошибка или таймаут не
 * блокируют очередь: следующий вызов начнётся, даже если зависший так и не завершился.
 */
export function withKeyLock<T>(key: string, fn: () => Promise<T>, timeoutMs = INSTALLER_CALL_TIMEOUT_MS): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.then(() => withTimeout(fn(), timeoutMs))
  const tail = run.then(() => undefined, () => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

export interface InstallerDeps {
  kv: KeyValue
  memberId: string
  /** Клиент REST по записи о портале: токены, их сохранение после рефреша (b24Client.makePortalCall). */
  clientFor: (record: PortalRecord) => RestCall
}

/**
 * `RestCall` токеном установщика: каждый вызов — по свежей записи о портале и в очереди портала.
 * Портала уже нет (удалили приложение) — исключение.
 */
export function makeInstallerCall(deps: InstallerDeps): RestCall {
  return (method, params) => withKeyLock(`installer:${deps.memberId.toLowerCase()}`, async () => {
    const record = await getPortal(deps.kv, deps.memberId)
    if (!record) throw new Error('portal not installed')
    return deps.clientFor(record)(method, params)
  })
}
