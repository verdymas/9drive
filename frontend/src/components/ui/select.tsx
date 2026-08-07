import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Styled native `<select>` matching the app's input/button look.
 * A native element keeps the modal fully keyboard-accessible and avoids a
 * headless-listbox dependency for two option groups.
 */
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}
