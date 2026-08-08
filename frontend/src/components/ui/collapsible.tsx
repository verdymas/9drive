import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Minimal disclosure primitive: a header button that toggles a content region
 * (Advanced Request Options). Children are unmounted while collapsed, so the
 * fields never exist in the DOM (and never hold focus) when hidden.
 */
export function Collapsible({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="grid gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-slate-900"
      >
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
        {title}
      </button>
      {open ? <div className="grid gap-3">{children}</div> : null}
    </div>
  )
}
