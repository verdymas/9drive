import * as React from 'react'
import { cn } from '@/lib/utils'

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm', className)} {...props} />
}
