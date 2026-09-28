// Заголовки безопасности страниц. Главное — `frame-ancestors`: страницы приложения открываются
// во фрейме портала, и встраивать их разрешено только порталам Битрикс24 (облачным зонам и
// коробкам из B24_SELFHOSTED_HOSTS). X-Frame-Options не ставим — он запретил бы и портал.

import { frameAncestors } from '../utils/b24Host'

let cached: string | null = null

export default defineEventHandler((event) => {
  if (event.path.startsWith('/api/')) return
  cached ??= frameAncestors(process.env.B24_SELFHOSTED_HOSTS)
  setResponseHeader(event, 'Content-Security-Policy', cached)
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
})
