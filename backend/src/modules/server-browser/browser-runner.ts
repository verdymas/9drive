import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import tls from 'node:tls'

const execFileAsync = promisify(execFile)

/**
 * Per-session browser container orchestration through the Docker CLI.
 *
 * Security: user input is NEVER interpolated into a shell string. Every
 * invocation goes through `execFile` with an argument array. Container names,
 * volume names, and every flag value are server-generated (opaque hex ids and
 * validated env config) — never raw request data.
 *
 * The runner never publishes ports (`-p`), never mounts the Docker socket
 * into browser containers, and never runs privileged containers. Browser
 * containers live on the isolated `internal: true` browser network whose only
 * egress is the Squid forward proxy.
 */

export type RunResult = { stdout: string; stderr: string; code: number | null }

/** The only surface the service depends on — easy to fake in tests. */
export interface ContainerRunner {
  run(args: string[], options?: { timeoutMs?: number }): Promise<RunResult>
}

export class DockerCliRunner implements ContainerRunner {
  async run(args: string[], options: { timeoutMs?: number } = {}): Promise<RunResult> {
    const { timeoutMs = 30_000 } = options
    try {
      const { stdout, stderr } = await execFileAsync('docker', args, {
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      })
      return { stdout, stderr, code: 0 }
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }
      if (err.code === 'ENOENT') {
        return { stdout: '', stderr: 'command not found: docker', code: null }
      }
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : err.message,
        code: typeof err.code === 'number' ? err.code : 1,
      }
    }
  }
}

export type BrowserContainerSpec = {
  /** Server-generated `9drive-browser-<hex>` name. Never user input. */
  name: string
  /** Pinned image, e.g. `kasmweb/chromium:1.19.0`. From validated env. */
  image: string
  network: string
  egressProxyUrl: string
  vncPassword?: string
  memory: string
  cpus: string
  pidsLimit: number
  /** Server-generated `9drive-browser-profile-<hex>` volume. Never user input. */
  profileVolume: string
}

/**
 * Build the `docker run` argument array for one isolated browser container.
 * Never log the returned array: it may contain the VNC password.
 */
export function buildRunArgs(spec: BrowserContainerSpec): string[] {
  // tmpfs options matter: KasmVNC runs as the unprivileged image user
  // (uid/gid 1000) with ALL capabilities dropped, so /run must be owned by
  // that user or PulseAudio cannot create /run/pulse and the entrypoint
  // aborts. /tmp additionally needs `exec` — Kasm services ship as staticx
  // self-extractors that fail with EPERM on Docker's default noexec tmpfs.
  const args = [
    'run',
    '-d',
    '--rm',
    '--name',
    spec.name,
    '--network',
    spec.network,
    '--memory',
    spec.memory,
    '--cpus',
    spec.cpus,
    '--pids-limit',
    String(spec.pidsLimit),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--shm-size',
    '256m',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=1777',
    '--tmpfs',
    '/run:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777',
    '-v',
    `${spec.profileVolume}:/home/kasm-user`,
    '-e',
    `HTTP_PROXY=${spec.egressProxyUrl}`,
    '-e',
    `HTTPS_PROXY=${spec.egressProxyUrl}`,
    '-e',
    'NO_PROXY=localhost,127.0.0.1,browser-egress-proxy',
  ]
  if (spec.vncPassword) {
    args.push('-e', `VNC_PW=${spec.vncPassword}`)
  }
  args.push(spec.image)
  return args
}

export class BrowserBackend {
  constructor(private readonly runner: ContainerRunner = new DockerCliRunner()) {}

  /** True when the Docker CLI can reach a daemon. */
  async available(): Promise<boolean> {
    const result = await this.runner.run(['info'], { timeoutMs: 10_000 })
    return result.code === 0
  }

  async launch(spec: BrowserContainerSpec): Promise<void> {
    const result = await this.runner.run(buildRunArgs(spec), { timeoutMs: 60_000 })
    if (result.code !== 0) {
      // Never propagate raw daemon output: it can leak host paths and versions.
      throw new Error(`browser container failed to start (exit ${result.code ?? 'unknown'})`)
    }
  }

  /** True when the container exists and is running. */
  async isRunning(name: string): Promise<boolean> {
    const result = await this.runner.run(['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 10_000 })
    return result.code === 0 && result.stdout.trim() === 'true'
  }

  /**
   * True when the container's KasmVNC display port completes a TLS handshake.
   * KasmVNC serves HTTPS with a container-generated self-signed certificate,
   * so verification is disabled — this only proves the UI is listening on the
   * isolated network, it authenticates nothing. Used to promote sessions to
   * `ready` only when the display is actually reachable, so the gateway never
   * 502s on a merely-started container.
   */
  async isDisplayServing(name: string, port: number, timeoutMs = 5_000): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const finish = (value: boolean) => {
        if (done) return
        done = true
        resolve(value)
      }
      const timer = setTimeout(() => {
        try {
          socket.destroy()
        } catch {
          /* noop */
        }
        finish(false)
      }, timeoutMs)
      const socket = tls.connect({ host: name, port, rejectUnauthorized: false }, () => {
        clearTimeout(timer)
        try {
          socket.end()
        } catch {
          /* noop */
        }
        finish(true)
      })
      socket.on('error', () => {
        clearTimeout(timer)
        finish(false)
      })
    })
  }

  /** Stop and remove the container. Best-effort: returns false when it is already gone. */
  async stop(name: string): Promise<boolean> {
    const result = await this.runner.run(['rm', '-f', name], { timeoutMs: 30_000 })
    return result.code === 0
  }

  /**
   * Names of 9Drive-managed browser containers (`9drive-browser-<16hex>`).
   * The egress proxy (`9drive-browser-egress-proxy`) never matches the
   * suffix pattern and is never returned. Used by the sweeper to reap
   * containers whose session row is gone.
   */
  async listManagedContainers(): Promise<string[]> {
    const result = await this.runner.run(
      ['ps', '-a', '--filter', 'name=9drive-browser-', '--format', '{{.Names}}'],
      { timeoutMs: 15_000 },
    )
    if (result.code !== 0) return []
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => /^9drive-browser-[0-9a-f]{16}$/.test(name))
  }

  /** Remove the per-session profile volume. Best-effort: missing volumes are fine. */
  async removeProfileVolume(volume: string): Promise<boolean> {
    const result = await this.runner.run(['volume', 'rm', volume], { timeoutMs: 30_000 })
    return result.code === 0
  }
}
