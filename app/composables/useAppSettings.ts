// Настройки и ставки портала: чтение прямо из фрейма (app.option.get доступен любому
// сотруднику), запись — через наш сервер (/api/settings, /api/rates), который проверяет права.
// Почему запись не из фрейма — docs/SETTINGS.md, раздел «Кто что может менять».

import { parseRates, serializeRates, type RateEntry } from '#shared/domain/rates'
import { canEditRates, defaultSettings, parseSettings, RATES_KEY, serializeSettings, SETTINGS_KEY, type AppSettings } from '#shared/domain/settings'
import { storageUsage, type StorageUsage } from '#shared/domain/storageBudget'

export function useAppSettings() {
  const { call, getOrThrow } = useB24()
  const { post } = useApi()

  const settings = useState<AppSettings>('app-settings', defaultSettings)
  const rates = useState<RateEntry[]>('app-rates', () => [])
  /** Все опции приложения как есть — для точного подсчёта места. */
  const options = useState<Record<string, string>>('app-options', () => ({}))
  const loaded = useState('app-settings-loaded', () => false)
  /** Чтение не удалось: сохранять нельзя, иначе умолчания затёрли бы настоящие настройки. */
  const loadFailed = useState('app-settings-load-failed', () => false)
  const userId = useState('app-user-id', () => 0)
  const isAdmin = useState('app-user-admin', () => false)

  const mayEditRates = computed(() => canEditRates(settings.value, userId.value, isAdmin.value))

  async function load(): Promise<void> {
    loadFailed.value = false
    try {
      const [all, profile] = await Promise.all([
        call<Record<string, unknown> | null>('app.option.get'),
        call<{ ID?: unknown, ADMIN?: unknown }>('profile')
      ])
      const flat: Record<string, string> = {}
      for (const [key, value] of Object.entries(all ?? {})) {
        flat[key] = typeof value === 'string' ? value : JSON.stringify(value ?? '')
      }
      options.value = flat
      settings.value = parseSettings(flat[SETTINGS_KEY])
      rates.value = parseRates(flat[RATES_KEY])
      userId.value = Number(profile?.ID) || 0
      // Флаг из profile — тот же, что проверяет сервер; `auth.isAdmin` фрейма — запасной.
      isAdmin.value = profile?.ADMIN === true || getOrThrow().auth.isAdmin
      loaded.value = true
    } catch (e) {
      loadFailed.value = true
      throw e
    }
  }

  /** Сколько места займут опции, если сохранить эти значения (для индикатора в настройках). */
  function usageWith(patch: { settings?: AppSettings, rates?: RateEntry[] }): StorageUsage {
    return storageUsage({
      ...options.value,
      ...(patch.settings ? { [SETTINGS_KEY]: serializeSettings(patch.settings) } : {}),
      ...(patch.rates ? { [RATES_KEY]: serializeRates(patch.rates) } : {})
    })
  }

  async function saveSettings(next: AppSettings): Promise<void> {
    if (loadFailed.value) throw new Error('Настройки не загрузились — сохранение заблокировано, чтобы не затереть их')
    await post('/api/settings', { settings: next })
    settings.value = parseSettings(next)
    options.value = { ...options.value, [SETTINGS_KEY]: serializeSettings(next) }
  }

  async function saveRates(next: RateEntry[]): Promise<void> {
    if (loadFailed.value) throw new Error('Ставки не загрузились — сохранение заблокировано, чтобы не затереть их')
    await post('/api/rates', { rates: next })
    rates.value = parseRates(serializeRates(next))
    options.value = { ...options.value, [RATES_KEY]: serializeRates(next) }
  }

  return { settings, rates, options: readonly(options), loaded, loadFailed, userId, isAdmin, mayEditRates, load, usageWith, saveSettings, saveRates }
}
