import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Human relative time ("2 minutes ago"); null/absent → "Never". */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'Never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'Never'
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000))
  if (seconds < 45) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
