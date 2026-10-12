import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDisplayBase, buildUpgradeHead, buildUpstreamHeaders, buildUpstreamPath, parseDisplayUpgrade, toUndiciHeaders } from './server-browser.routes.js'

describe('buildUpstreamPath', () => {
  it('forwards same-origin display sub-paths', () => {
    expect(buildUpstreamPath('/')).toBe('/')
    expect(buildUpstreamPath('/vnc.html?autoconnect=true')).toBe('/vnc.html?autoconnect=true')
    expect(buildUpstreamPath('/websockify?token=abc')).toBe('/websockify?token=abc')
  })

  it('rejects protocol-relative host overrides', () => {
    expect(() => buildUpstreamPath('//evil.example')).toThrow('Invalid display path.')
  })

  it('rejects absolute URLs so the gateway can never become an open proxy', () => {
    expect(() => buildUpstreamPath('/https://evil.example/')).toThrow('Invalid display path.')
    expect(() => buildUpstreamPath('/http://169.254.169.254/')).toThrow('Invalid display path.')
  })

  it('rejects non-path input', () => {
    expect(() => buildUpstreamPath('vnc.html')).toThrow('Invalid display path.')
  })
})

describe('buildDisplayBase', () => {
  it('always targets the KasmVNC display port, never DevTools', () => {
    const base = buildDisplayBase('9drive-browser-0123456789abcdef')
    expect(base).toBe('https://9drive-browser-0123456789abcdef:6901')
    expect(base).not.toContain('9222')
  })
})

describe('buildUpstreamHeaders', () => {
  it('forwards the Kasm UI Basic credential so its login can complete', () => {
    const headers = buildUpstreamHeaders({ authorization: 'Basic a2FzbS11c2VyOnBhc3N3b3Jk', cookie: 'kasm=1' })
    expect(headers).toContainEqual(['authorization', 'Basic a2FzbS11c2VyOnBhc3N3b3Jk'])
    expect(headers).toContainEqual(['cookie', 'kasm=1'])
  })

  it('strips bearer tokens so the 9Drive session credential never reaches a browser container', () => {
    const headers = buildUpstreamHeaders({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9', cookie: 'kasm=1' })
    expect(headers.some(([name]) => name.toLowerCase() === 'authorization')).toBe(false)
    expect(headers).toContainEqual(['cookie', 'kasm=1'])
  })

  it('strips proxy and framing headers', () => {
    const headers = buildUpstreamHeaders({
      'proxy-authorization': 'Basic eA==',
      host: 'backend:4000',
      'content-length': '12',
      'x-custom': 'kept',
    })
    expect(headers).toEqual([['x-custom', 'kept']])
  })

  it('shapes headers for undici (records, never tuple arrays)', () => {
    // Regression: undici's low-level request() throws
    // `headers array must be even` on tuple arrays, which 502d the gateway.
    const shaped = toUndiciHeaders({ authorization: 'Basic a2FzbQ==', cookie: 'kasm=1', host: 'x' })
    expect(shaped).toEqual({ authorization: 'Basic a2FzbQ==', cookie: 'kasm=1' })
    expect(Array.isArray(shaped)).toBe(false)
    expect(toUndiciHeaders({ 'x-multi': ['a', 'b'] })).toEqual({ 'x-multi': ['a', 'b'] })
  })

  it('builds a complete upgrade head with a rewritten host', () => {
    // Regression: the relay wrote the head on TLS `connect` (pre-handshake)
    // and sent no Host at all — every WebSocket handshake died.
    const head = buildUpgradeHead({
      method: 'GET',
      httpVersion: '1.1',
      upstreamPath: '/websockify?token=t',
      headers: {
        host: 'localhost:5178',
        upgrade: 'websocket',
        connection: 'Upgrade',
        authorization: 'Bearer must-not-cross',
        'sec-websocket-key': 'abc',
      },
      upstreamHost: '9drive-browser-abc:6901',
    })
    const lines = head.split('\r\n')
    expect(lines[0]).toBe('GET /websockify?token=t HTTP/1.1')
    expect(lines).toContain('upgrade: websocket')
    expect(lines).toContain('host: 9drive-browser-abc:6901')
    expect(lines.filter((l) => l.toLowerCase().startsWith('host:'))).toHaveLength(1)
    expect(head).not.toContain('Bearer')
    expect(head.endsWith('\r\n\r\n')).toBe(true)
  })
})

describe('parseDisplayUpgrade', () => {
  it('extracts session, gateway-relative upstream path, and token', () => {
    // The mount prefix is stripped exactly like the HTTP gateway: KasmVNC
    // builds its WebSocket URL relative to the page (`/websockify`), so a
    // `/display`-prefixed upstream path would 404 and break the desktop.
    expect(parseDisplayUpgrade('/server-browser/sessions/abc/display/websockify?token=t')).toEqual({
      sessionId: 'abc',
      upstreamPath: '/websockify?token=t',
      token: 't',
    })
    expect(parseDisplayUpgrade('/server-browser/sessions/abc/display?token=t')).toEqual({
      sessionId: 'abc',
      upstreamPath: '/?token=t',
      token: 't',
    })
  })

  it('returns null for non-display paths', () => {
    expect(parseDisplayUpgrade('/files/abc/download')).toBeNull()
    expect(parseDisplayUpgrade('/server-browser/sessions')).toBeNull()
    expect(parseDisplayUpgrade('not a url %%%')).toBeNull()
  })

  it('returns null for host-override attempts', () => {
    expect(parseDisplayUpgrade('/server-browser/sessions/abc/display//evil.example/x?token=t')).toBeNull()
  })
})

describe('browser ports are not publicly exposed', () => {
  it('no route or runner targets the DevTools port', () => {
    for (const file of ['server-browser.routes.ts', 'browser-runner.ts', 'server-browser.service.ts']) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
      // String/port-bound references only — prose comments are fine.
      expect(source).not.toMatch(/['":]9222/)
    }
  })

  it('the browser runner never publishes container ports', () => {
    const source = fs.readFileSync(path.join(__dirname, 'browser-runner.ts'), 'utf8')
    expect(source).not.toContain("'--publish'")
    expect(source).not.toContain("'-p'")
    expect(source).not.toContain('--privileged')
    expect(source).not.toContain('docker.sock')
  })

  it('compose publishes no browser display or DevTools port', () => {
    const compose = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'docker-compose.yml'), 'utf8')
    const published = compose.split('\n').filter((line) => /"(6901|9222|5900|5901):/.test(line) || /-\s*"(6901|9222|5900|5901)/.test(line))
    expect(published).toEqual([])
  })

  it('the egress proxy service stays internal-only (no ports)', () => {
    const compose = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'docker-compose.yml'), 'utf8')
    const lines = compose.split('\n').map((line) => line.replace(/\r$/, ''))
    const start = lines.findIndex((line) => line === '  browser-egress-proxy:')
    expect(start).toBeGreaterThan(-1)
    const block: string[] = []
    for (let i = start + 1; i < lines.length; i++) {
      if (/^  \S.*:$/.test(lines[i]) || /^volumes:$/.test(lines[i]) || /^networks:$/.test(lines[i])) break
      block.push(lines[i])
    }
    expect(block.filter((line) => /^\s+ports:/.test(line))).toEqual([])
    expect(block.some((line) => line.includes('3128'))).toBe(true)
  })
})
