import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const cryptoId = await import('./backend/dist/utils/crypto.js').catch((e) => { console.log('dist crypto import failed:', e.message.slice(0,120)); return null })
if (!cryptoId) process.exit(1)
const rows = await prisma.remoteFetchWorker.findMany({ take: 5, orderBy: { updatedAt: 'desc' } })
for (const r of rows) {
  if (!r.configEncrypted) continue
  try {
    const parsed = JSON.parse(cryptoId.decryptText(r.configEncrypted))
    const cfg = parsed.config || {}
    const tok = parsed.credentials?.apiToken
    const acct = cfg.accountId
    const name = cfg.workerName
    const resp = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { authorization: `Bearer ${tok}` },
    })
    console.log(`worker=${name} account=${acct} tokenVerify=${resp.status === 200 ? 'VALID' : `INVALID(${resp.status})`}`)
  } catch (e) {
    console.log(`worker=${r.name} decrypt-failed: ${e.message.slice(0, 80)}`)
  }
}
await prisma.$disconnect()
process.exit(0)
