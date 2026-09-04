import { useEffect, useState } from 'react'
import { ShieldCheck, Copy, Check } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  buildTelegramEncryptedCaption,
  convertTelegramCaptionToEncrypted,
  getTelegramSecurityStatus,
  telegramEncryptionLabel,
  type TelegramEncryptedCaption,
  type TelegramSecurityStatus,
} from '@/lib/telegram'

/**
 * Settings → Telegram Metadata Security.
 *
 * Shows only whether the master key is configured — never the key itself,
 * which lives on the backend and is never sent to the browser. The repair
 * flow builds the caption for a file id so the user can paste it back into
 * Telegram when a message's metadata was lost; the next sync picks it up.
 */
export function TelegramSecurityCard() {
  const [status, setStatus] = useState<TelegramSecurityStatus | null>(null)
  const [fileId, setFileId] = useState('')
  const [result, setResult] = useState<TelegramEncryptedCaption | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void getTelegramSecurityStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  const run = async (action: 'encrypt' | 'convert') => {
    if (!fileId.trim()) return
    setBusy(true); setError(null); setNotice(null)
    try {
      if (action === 'encrypt') {
        setResult(await buildTelegramEncryptedCaption(fileId.trim()))
      } else {
        const out = await convertTelegramCaptionToEncrypted(fileId.trim())
        setResult(null)
        setNotice(out.changed ? `Caption updated on message ${out.messageId}.` : 'The caption already matched — nothing changed.')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copyCaption = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.caption)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — the textarea is selectable as a fallback */
    }
  }

  if (!status) return null
  const configured = status.encryption === 'configured'

  return (
    <Card className="overflow-hidden p-3.5">
      <div className="flex flex-col gap-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5"><ShieldCheck className="h-5 w-5 text-blue-600" /><h2 className="text-[16px] font-bold">Telegram Metadata Security</h2></div>
          <p className="mt-1 text-[13px] text-slate-500">Filenames and paths stored on Telegram are encrypted. 9Drive stays the source of truth; the master key never leaves the server.</p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className={configured ? 'rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700' : status.encryption === 'invalid' ? 'rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700' : 'rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-500'}>
            Encryption: {telegramEncryptionLabel(status.encryption)}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-500">
            Filenames: {status.filenameObfuscation === 'enabled' ? 'Obfuscated' : 'Plain'}
          </span>
        </div>
      </div>

      {status.encryption === 'invalid' ? (
        <p className="mt-3 rounded-xl bg-rose-50 p-2.5 text-xs text-rose-800">
          The configured master key is invalid (it must be at least 32 characters). Protected uploads are refused rather than falling back to plaintext. Fix <code>TELEGRAM_METADATA_MASTER_KEY</code> and restart the backend.
        </p>
      ) : null}

      {configured ? (
        <div className="mt-3 rounded-xl border border-slate-100 p-3 dark:border-slate-800">
          <p className="text-xs font-semibold text-slate-500">Repair a Telegram message whose metadata was lost</p>
          <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row">
            <input
              className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm focus:outline-none dark:bg-slate-950"
              placeholder="9Drive file id"
              value={fileId}
              onChange={(e) => setFileId(e.target.value)}
              aria-label="9Drive file id"
            />
            <Button size="sm" variant="outline" onClick={() => void run('encrypt')} disabled={busy || !fileId.trim()}>Build caption</Button>
            <Button size="sm" variant="outline" onClick={() => void run('convert')} disabled={busy || !fileId.trim()} title="Rewrites the Telegram caption in place. The file itself is not re-uploaded.">Update on Telegram</Button>
          </div>

          {error ? <p className="mt-2 rounded-xl bg-rose-50 p-2.5 text-xs text-rose-800">{error}</p> : null}
          {notice ? <p className="mt-2 rounded-xl bg-blue-50 p-2.5 text-xs text-blue-700">{notice}</p> : null}

          {result ? (
            <div className="mt-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-500">Paste this as the message caption in Telegram, then run Sync.</p>
                <Button size="sm" variant="outline" onClick={copyCaption}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? 'Copied' : 'Copy'}</Button>
              </div>
              <textarea
                readOnly
                rows={4}
                className="mt-1.5 w-full break-all rounded-lg border border-slate-100 bg-white px-2 py-1.5 font-mono text-[12px] dark:border-slate-800 dark:bg-slate-950"
                value={result.caption}
                aria-label="Encrypted Telegram caption"
              />
              {result.physicalFilename ? (
                <p className="mt-1.5 text-[11px] text-slate-500">Expected document filename on Telegram: <code>{result.physicalFilename}</code></p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
