// Сотрудники: имена по ID (кэш на время страницы) и выбор штатным диалогом портала
// ($b24.dialog.selectUser / selectUsers — документация DialogManager в b24jssdk).

export function useUsers() {
  const b24 = useB24()
  const names = useState<Record<number, string>>('user-names', () => ({}))

  /** Подгружает имена недостающих сотрудников. Сбой не страшен — покажем #ID. */
  async function load(ids: number[]): Promise<void> {
    const unknown = [...new Set(ids)].filter(id => id > 0 && !names.value[id])
    if (!unknown.length) return
    try {
      const users = await b24.batch<Array<Record<string, unknown>>>(unknown.map(id => ['user.get', { ID: id }]))
      const next = { ...names.value }
      for (const u of users.flat()) {
        const id = Number(u?.ID)
        const name = [u?.NAME, u?.LAST_NAME].filter(v => typeof v === 'string' && v).join(' ')
        if (id) next[id] = name || `#${id}`
      }
      names.value = next
    } catch {
      // Имена — удобство; без них интерфейс работает на #ID.
    }
  }

  function label(id: number): string {
    return names.value[id] ?? `#${id}`
  }

  async function pickOne(): Promise<number | null> {
    const picked = await b24.getOrThrow().dialog.selectUser()
    if (!picked) return null
    const id = Number(picked.id)
    if (id > 0) names.value = { ...names.value, [id]: picked.name }
    return id > 0 ? id : null
  }

  async function pickMany(): Promise<number[]> {
    const picked = await b24.getOrThrow().dialog.selectUsers()
    const next = { ...names.value }
    const ids: number[] = []
    for (const u of picked) {
      const id = Number(u.id)
      if (id > 0) {
        ids.push(id)
        next[id] = u.name
      }
    }
    names.value = next
    return ids
  }

  return { names, load, label, pickOne, pickMany }
}
