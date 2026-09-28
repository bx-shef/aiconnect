// «Реквизиты вашей компании» для вкладки «НДС»: компании CRM с признаком «моя компания». Параметры
// запроса — app/utils/invoiceRequests.ts (их же шлёт смок), замер — docs/REST_METHODS.md. Их ID —
// поле `mycompanyId` счёта.

import { parseMyCompanies, type MyCompany } from '#shared/domain/vat'
import { MY_COMPANIES_PAGE, myCompaniesCall } from '~/utils/invoiceRequests'
import { collectOffsetPages } from '~/utils/paging'

/** Потолок: столько реквизитов на портале не бывает, а бесконечный цикл по битому ответу — бывает. */
const MAX_COMPANIES = 500

export function useMyCompanies() {
  const b24 = useB24()

  async function list(): Promise<MyCompany[]> {
    // Разбираем после сбора: страница с битой строкой короче 50, и листание кончилось бы раньше.
    const raw = await collectOffsetPages(
      async (start) => {
        const { method, params } = myCompaniesCall(start)
        const res = await b24.call<{ items?: unknown[] }>(method, params)
        return Array.isArray(res?.items) ? res.items : []
      },
      MY_COMPANIES_PAGE,
      MAX_COMPANIES,
      `«Реквизитов вашей компании» в портале больше ${MAX_COMPANIES} — такой список приложение не показывает`
    )
    return parseMyCompanies(raw)
  }

  return { list }
}
