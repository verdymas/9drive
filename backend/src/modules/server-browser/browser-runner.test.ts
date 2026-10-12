import { describe, expect, it, vi } from 'vitest'
import { BrowserBackend, buildRunArgs, type BrowserContainerSpec } from './browser-runner.js'

function spec(overrides: Partial<BrowserContainerSpec> = {}): BrowserContainerSpec {
  return {
    name: '9drive-browser-0123456789abcdef',
    image: 'kasmweb/chromium:1.19.0',
    network: '9drive_browser_net',
    egressProxyUrl: 'http://browser-egress-proxy:3128',
    memory: '2g',
    cpus: '2',
    pidsLimit: 256,
    profileVolume: '9drive-browser-profile-0123456789abcdef',
    ...overrides,
  }
}

describe('buildRunArgs', () => {
  it('pins the image and joins the isolated network', () => {
    const args = buildRunArgs(spec())
    expect(args).toContain('kasmweb/chromium:1.19.0')
    expect(args).toContain('--network')
    expect(args[args.indexOf('--network') + 1]).toBe('9drive_browser_net')
  })

  it('applies CPU, memory, and process limits', () => {
    const args = buildRunArgs(spec())
    expect(args).toContain('--memory')
    expect(args[args.indexOf('--memory') + 1]).toBe('2g')
    expect(args).toContain('--cpus')
    expect(args[args.indexOf('--cpus') + 1]).toBe('2')
    expect(args).toContain('--pids-limit')
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('256')
  })

  it('drops capabilities and forbids privilege escalation', () => {
    const args = buildRunArgs(spec())
    expect(args).toContain('--cap-drop')
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL')
    expect(args).toContain('--security-opt')
    expect(args).toContain('no-new-privileges:true')
    expect(args).not.toContain('--privileged')
  })

  it('never publishes ports and never mounts the Docker socket', () => {
    const args = buildRunArgs(spec())
    expect(args).not.toContain('-p')
    expect(args).not.toContain('--publish')
    expect(args).not.toContain('--expose')
    expect(args.join('\n')).not.toContain('docker.sock')
  })

  it('mounts an isolated per-session profile volume', () => {
    const args = buildRunArgs(spec())
    expect(args).toContain('-v')
    expect(args[args.indexOf('-v') + 1]).toBe('9drive-browser-profile-0123456789abcdef:/home/kasm-user')
  })

  it('gives the unprivileged image user writable /run and executable /tmp', () => {
    const args = buildRunArgs(spec())
    const tmpfsValues = args.filter((_, i) => args[i - 1] === '--tmpfs')
    // /run must be uid/gid-owned or PulseAudio cannot create /run/pulse and
    // the Kasm entrypoint aborts; /tmp must allow exec or the staticx-packed
    // Kasm services die with EPERM (Docker tmpfs defaults to noexec).
    expect(tmpfsValues).toContain('/tmp:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=1777')
    expect(tmpfsValues).toContain('/run:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777')
  })

  it('routes all egress through the filtering proxy', () => {
    const args = buildRunArgs(spec())
    expect(args).toContain('HTTP_PROXY=http://browser-egress-proxy:3128')
    expect(args).toContain('HTTPS_PROXY=http://browser-egress-proxy:3128')
  })
})

describe('BrowserBackend', () => {
  it('reports unavailable when the Docker CLI cannot reach a daemon', async () => {
    const runner = { run: vi.fn(async () => ({ stdout: '', stderr: 'nope', code: 1 })) }
    await expect(new BrowserBackend(runner).available()).resolves.toBe(false)
  })

  it('isDisplayServing is false (never throws) when nothing listens', async () => {
    const backend = new BrowserBackend({ run: vi.fn() })
    await expect(backend.isDisplayServing('9drive-browser-missing', 6901, 2_000)).resolves.toBe(false)
  })

  it('maps launch failures to a safe error without daemon internals', async () => {
    const runner = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'info') return { stdout: '', stderr: '', code: 0 }
        return { stdout: '', stderr: 'host path /secret leaked', code: 125 }
      }),
    }
    await expect(new BrowserBackend(runner).launch(spec())).rejects.toThrow('browser container failed to start')
    await expect(new BrowserBackend(runner).launch(spec())).rejects.not.toThrow('/secret')
  })

  it('treats a missing container as already stopped (idempotent cleanup)', async () => {
    const runner = { run: vi.fn(async () => ({ stdout: '', stderr: 'No such container', code: 1 })) }
    await expect(new BrowserBackend(runner).stop('9drive-browser-missing')).resolves.toBe(false)
  })

  it('lists only managed browser containers, never the egress proxy', async () => {
    const runner = {
      run: vi.fn(async () => ({
        stdout: '9drive-browser-0123456789abcdef\n9drive-browser-egress-proxy\n9drive-backend-1\n',
        stderr: '',
        code: 0,
      })),
    }
    await expect(new BrowserBackend(runner).listManagedContainers()).resolves.toEqual([
      '9drive-browser-0123456789abcdef',
    ])
  })

  it('returns no containers when Docker is unreachable', async () => {
    const runner = { run: vi.fn(async () => ({ stdout: '', stderr: 'boom', code: 1 })) }
    await expect(new BrowserBackend(runner).listManagedContainers()).resolves.toEqual([])
  })
})
