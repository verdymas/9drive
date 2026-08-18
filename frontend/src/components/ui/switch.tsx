import { cn } from '@/lib/utils'

/**
 * Accessible ON/OFF switch (role="switch" button — not a clickable div).
 * Keyboard activatable via native button semantics; `aria-checked` reflects
 * state and `aria-label` carries the per-instance accessible name.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  'aria-label': ariaLabel,
  className,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  'aria-label'?: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50',
        checked ? 'bg-blue-600' : 'bg-slate-300',
        className,
      )}
    >
      <span
        className={cn(
          'pointer-events-none block h-5 w-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
