import type { RelayProviderCapabilities } from './types.js'

/**
 * Verified free-tier relay capabilities (docs current Oct 2026).
 *
 * - Cloudflare Workers Free: 100,000 req/day, 10 ms CPU/invocation (network
 *   wait excluded), 128 MB, 50 subrequests/invocation, no enforced
 *   response-body cap. Hard stop: Error 1027 at the daily limit.
 *   Source: https://developers.cloudflare.com/workers/platform/limits/
 * - Deno Deploy Free: 1M req/month, 20 GiB egress/month (binding for media),
 *   manual-endpoint only in this phase. Hard stop: service pause at limit.
 *   Sources: https://deno.com/deploy/pricing, https://docs.deno.com/deploy/
 * - Vercel Hobby (evaluated-only, no driver): personal non-commercial use,
 *   120 s proxied-request timeout, Fluid Hobby max duration 300 s, hard pause
 *   at limits. Not dependable for long/large transfers without proof.
 *   Sources: https://vercel.com/docs/plans/hobby, https://vercel.com/docs/limits
 * - Netlify Free (excluded): 60 s sync execution, 20 MB streamed response cap.
 *   Incompatible with general large-media relay.
 *   Source: https://docs.netlify.com/build/functions/configuration/
 *
 * 9Drive safety budgets sit conservatively BELOW published limits (see
 * safetyBudgets below). Providers can change plans at any time — never claim
 * permanent free availability.
 */

export const CLOUDFLARE_CAPABILITIES: RelayProviderCapabilities = {
  providerType: 'cloudflare',
  streaming: true,
  rangeRequests: true,
  maxRequestDurationMs: null,
  maxResponseBytes: null,
  managed: true,
  freeTier: {
    requestsPerMonth: null, // daily-capped instead: 100k/day
    egressBytesPerMonth: null,
    note: 'Workers Free: 100,000 requests/day; 10 ms CPU/invocation; hard Error 1027 at limit.',
  },
  hardStopBehavior: 'Cloudflare returns Error 1027 and pauses the Worker until midnight UTC reset.',
  selectable: true,
}

export const DENO_CAPABILITIES: RelayProviderCapabilities = {
  providerType: 'deno',
  streaming: true,
  rangeRequests: true,
  // Deno Deploy documents no fixed wall-clock per-request cap for the new
  // platform; treat long transfers as smoke-test-gated. Conservative local
  // default enforced by the transport timeout, not the platform.
  maxRequestDurationMs: null,
  maxResponseBytes: null,
  managed: false,
  freeTier: {
    requestsPerMonth: 1_000_000,
    egressBytesPerMonth: 20 * 1024 * 1024 * 1024,
    note: 'Deno Free: 1M requests/month, 20 GiB egress/month — egress is binding for media.',
  },
  hardStopBehavior: 'Deno pauses deployments at the monthly quota until reset or upgrade.',
  selectable: true,
}

export const VPS_CAPABILITIES: RelayProviderCapabilities = {
  providerType: 'vps',
  streaming: true,
  rangeRequests: true,
  // Self-hosted relay: no provider wall-clock cap; transport timeouts bound the request.
  maxRequestDurationMs: null,
  maxResponseBytes: null,
  managed: false,
  freeTier: {
    requestsPerMonth: null,
    egressBytesPerMonth: null,
    note: 'Self-hosted VPS: no provider free-tier. Bandwidth/egress costs and capacity are operator-defined. Local safety budgets only.',
  },
  hardStopBehavior: 'Operator-defined: concurrency, timeout, and local safety-budget rejections are enforced by the relay and 9Drive; there is no provider pause.',
  selectable: true,
}

/** Conservative in-9Drive safety budgets (below published $0 limits). */
export const PROVIDER_SAFETY_BUDGETS: Record<string, { maxRequestsPerMonth: number | null; maxEgressBytesPerMonth: number | null }> = {
  cloudflare: {
    // ~80% of 100k/day × 30 days.
    maxRequestsPerMonth: 2_400_000,
    maxEgressBytesPerMonth: null,
  },
  deno: {
    maxRequestsPerMonth: 800_000,
    maxEgressBytesPerMonth: 16 * 1024 * 1024 * 1024,
  },
  vps: {
    // Self-hosted: unbounded by default; operators set explicit local safety budgets per worker.
    maxRequestsPerMonth: null,
    maxEgressBytesPerMonth: null,
  },
}

export const EVALUATED_ONLY_PROVIDERS: RelayProviderCapabilities[] = [
  {
    providerType: 'vercel',
    streaming: true,
    rangeRequests: true,
    maxRequestDurationMs: 120_000,
    maxResponseBytes: null,
    managed: false,
    freeTier: {
      requestsPerMonth: 1_000_000,
      egressBytesPerMonth: 100 * 1024 * 1024 * 1024,
      note: 'Hobby: personal non-commercial only; 120 s proxied timeout; hard pause at limits.',
    },
    hardStopBehavior: 'Vercel pauses the deployment until the next cycle or upgrade.',
    selectable: false,
    exclusionReason:
      'Evaluate-only: Hobby is personal non-commercial use and its 120 s proxied-request timeout is unproven for long/large transfers. No driver ships in this task.',
  },
  {
    providerType: 'netlify',
    streaming: true,
    rangeRequests: true,
    maxRequestDurationMs: 60_000,
    maxResponseBytes: 20 * 1024 * 1024,
    managed: false,
    freeTier: { requestsPerMonth: null, egressBytesPerMonth: null, note: '60 s sync execution; 20 MB streamed cap.' },
    hardStopBehavior: 'Function invocations fail past the execution/size cap.',
    selectable: false,
    exclusionReason:
      'Excluded: documented 20 MB streamed-response cap with a 60 s execution limit is incompatible with general large-media relay.',
  },
]
