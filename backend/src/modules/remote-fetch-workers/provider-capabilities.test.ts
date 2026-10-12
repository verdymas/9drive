import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_CAPABILITIES,
  DENO_CAPABILITIES,
  EVALUATED_ONLY_PROVIDERS,
  PROVIDER_SAFETY_BUDGETS,
} from './provider-capabilities.js'

describe('provider capabilities: free-tier relay adapters', () => {
  it('cloudflare keeps its existing behavior + diagnostics capability', () => {
    expect(CLOUDFLARE_CAPABILITIES.selectable).toBe(true)
    expect(CLOUDFLARE_CAPABILITIES.streaming).toBe(true)
    expect(CLOUDFLARE_CAPABILITIES.rangeRequests).toBe(true)
    expect(CLOUDFLARE_CAPABILITIES.managed).toBe(true)
    expect(CLOUDFLARE_CAPABILITIES.hardStopBehavior).toMatch(/1027/i)
  })

  it('deno manual provider declares streaming + range with egress as binding constraint', () => {
    expect(DENO_CAPABILITIES.selectable).toBe(true)
    expect(DENO_CAPABILITIES.managed).toBe(false)
    expect(DENO_CAPABILITIES.streaming).toBe(true)
    expect(DENO_CAPABILITIES.rangeRequests).toBe(true)
    expect(DENO_CAPABILITIES.freeTier.requestsPerMonth).toBe(1_000_000)
    expect(DENO_CAPABILITIES.freeTier.egressBytesPerMonth).toBe(20 * 1024 * 1024 * 1024)
  })

  it('safety budgets sit below published $0 limits', () => {
    expect(PROVIDER_SAFETY_BUDGETS.deno.maxRequestsPerMonth).toBeLessThan(1_000_000)
    expect(PROVIDER_SAFETY_BUDGETS.deno.maxEgressBytesPerMonth).toBeLessThan(20 * 1024 * 1024 * 1024)
    expect(PROVIDER_SAFETY_BUDGETS.cloudflare.maxRequestsPerMonth).toBeLessThanOrEqual(2_400_000)
  })

  it('vercel is evaluated-only with documented limits', () => {
    const vercel = EVALUATED_ONLY_PROVIDERS.find((p) => p.providerType === 'vercel')
    expect(vercel?.selectable).toBe(false)
    expect(vercel?.maxRequestDurationMs).toBe(120_000)
    expect(vercel?.exclusionReason).toMatch(/non-commercial|120/i)
  })

  it('netlify is excluded for the 20 MB streamed cap + 60 s limit', () => {
    const netlify = EVALUATED_ONLY_PROVIDERS.find((p) => p.providerType === 'netlify')
    expect(netlify?.selectable).toBe(false)
    expect(netlify?.maxResponseBytes).toBe(20 * 1024 * 1024)
    expect(netlify?.maxRequestDurationMs).toBe(60_000)
    expect(netlify?.exclusionReason).toMatch(/20 MB|large-media/i)
  })
})
