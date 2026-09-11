import { MonitorPlay, Radio } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type { HlsImportOptions, ProbeResult } from '@/lib/remoteImports'

const RECORDING_MIN_SECONDS = 60
const RECORDING_MAX_SECONDS = 21600

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function HlsSection({
  hls,
  value,
  onChange,
}: {
  hls: NonNullable<ProbeResult['hls']>
  value: HlsImportOptions
  onChange: (next: HlsImportOptions) => void
}) {
  const isLive = hls.isFinite === false
  const variants = hls.variants
  const tracks = hls.audioTracks

  return (
    <fieldset className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
      <legend className="sr-only">HLS options</legend>
      <p className="flex flex-wrap items-center gap-2 text-sm font-extrabold text-slate-800">
        <Radio className="h-4 w-4 text-blue-600" />
        HLS Video
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-blue-700">
          {hls.playlistType}
        </span>
      </p>

      {isLive ? (
        <p className="rounded-xl bg-amber-50 p-2.5 text-xs font-semibold text-amber-800">
          Live HLS stream detected. A recording duration is required.
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
          <MonitorPlay className="h-4 w-4" />
          {variants.length > 1 ? `${variants.length} quality levels available` : 'Single quality level'}
          {hls.durationSeconds != null && hls.durationSeconds > 0 ? ` · ${formatDuration(hls.durationSeconds)}` : ''}
        </p>
      )}

      {variants.length > 1 ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Quality
          <Select
            value={value.variantId ?? 'auto'}
            onChange={(event) => onChange({ ...value, variantId: event.target.value === 'auto' ? undefined : event.target.value })}
          >
            <option value="auto">Automatic (best available)</option>
            {variants.map((variant) => (
              <option key={variant.id} value={variant.id}>{variant.label}</option>
            ))}
          </Select>
        </label>
      ) : null}

      {tracks.length > 1 ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Audio Track
          <Select
            value={value.audioTrackId ?? 'auto'}
            onChange={(event) => onChange({ ...value, audioTrackId: event.target.value === 'auto' ? undefined : event.target.value })}
          >
            <option value="auto">Auto (default)</option>
            {tracks.map((track) => (
              <option key={track.id} value={track.id}>{track.name || track.language || 'Audio'}</option>
            ))}
          </Select>
        </label>
      ) : null}

      <label className="grid gap-1.5 text-sm font-semibold">
        Output Format
        <Select
          value={value.outputContainer ?? 'auto'}
          onChange={(event) => onChange({ ...value, outputContainer: event.target.value as HlsImportOptions['outputContainer'] })}
        >
          <option value="auto">Automatic (MKV)</option>
          <option value="mkv">MKV</option>
          <option value="mp4">MP4</option>
        </Select>
        {value.outputContainer === 'auto' ? (
          <span className="text-xs font-normal text-gray-500">Automatic uses MKV for maximum compatibility.</span>
        ) : null}
      </label>

      {isLive ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Recording Duration
          <Input
            type="number"
            min={RECORDING_MIN_SECONDS}
            max={RECORDING_MAX_SECONDS}
            step="1"
            value={value.recordingDurationSeconds ?? ''}
            onChange={(event) => {
              const raw = Number(event.target.value)
              onChange({ ...value, recordingDurationSeconds: Number.isInteger(raw) && raw > 0 ? raw : undefined })
            }}
            placeholder={`${RECORDING_MIN_SECONDS} – ${RECORDING_MAX_SECONDS} seconds`}
          />
          <span className="text-xs font-normal text-slate-400">
            {formatDuration(value.recordingDurationSeconds)} recording (between {RECORDING_MIN_SECONDS} and {RECORDING_MAX_SECONDS} seconds)
          </span>
        </label>
      ) : null}
    </fieldset>
  )
}
