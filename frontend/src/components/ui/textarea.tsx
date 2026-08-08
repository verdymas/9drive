import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Styled native `<textarea>` matching the app's Input look, but multi-line.
 * The cURL mode renders this with `font-mono` for pasted commands.
 */
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'min-h-24 w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}
