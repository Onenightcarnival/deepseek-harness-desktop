'use strict'
/**
 * The single place where "does this request go direct, or through which
 * proxy?" is decided.
 *
 * Every child process gets HTTP_PROXY=http://127.0.0.1:<port> pointing here
 * (see applyProxyEnv in runtime.js) and nothing else, so the shell window,
 * the dsh server, pnpm and every MCP server share one decision. This is what
 * a static HTTP_PROXY env var cannot do: a Windows system proxy is a PAC
 * script plus an exception list, i.e. a per-URL decision — flattening it into
 * one URL sends intranet traffic to the proxy and breaks it.
 *
 * No Electron dependency: `resolveSystem` is injected (main.js passes
 * Chromium's session.resolveProxy) so the whole thing runs under plain node
 * in tests.
 */
const http = require('http')
const net = require('net')
const { bypassPatterns, isBypassed } = require('./runtime.js')

/** "host:port" / "[::1]:port" -> [host, port] */
function splitHostPort(authority, fallbackPort) {
  const s = String(authority || '')
  const m = /^\[(.+)\]:(\d+)$/.exec(s) || /^([^:]+):(\d+)$/.exec(s)
  if (m) return [m[1], Number(m[2])]
  return [s.replace(/^\[|\]$/g, ''), fallbackPort]
}

/** null = direct; otherwise {host, port, auth} where auth is a header value. */
async function routeFor(config, resolveSystem, host, port, scheme) {
  const c = config || {}
  if (c.mode === 'none') return null
  if (isBypassed(host, bypassPatterns(c))) return null
  if (c.mode === 'manual') {
    const h = String(c.host || '').trim()
    const p = Number(String(c.port || '').trim())
    if (!h || !p) return null
    let auth = ''
    if (c.auth && c.login) {
      auth = 'Basic ' + Buffer.from(`${c.login}:${c.password || ''}`).toString('base64')
    }
    return { host: h, port: p, auth }
  }
  if (c.mode === 'system' && resolveSystem) {
    const r = await resolveSystem(`${scheme}://${host}:${port}`)
    if (r && r.host && r.port) return { host: r.host, port: Number(r.port), auth: '' }
  }
  return null
}

/**
 * Start a forwarder. Returns {port, close()}; port 0 means it could not
 * listen (callers then fall back to a merely-scrubbed env = direct).
 * `getConfig` is read per request, so saving a new proxy config takes effect
 * without restarting anything.
 */
function createForwarder({ getConfig, resolveSystem, onError } = {}) {
  const config = () => (typeof getConfig === 'function' ? getConfig() : getConfig) || {}
  const fail = (err) => { if (onError) { try { onError(err) } catch { /* best effort */ } } }

  // CONNECT: tunnel bytes, either straight to the target or through the
  // upstream proxy. TLS stays end-to-end, so cert validation (and the
  // corporate MITM CA) remains the child's business.
  async function onConnect(req, client, head) {
    const [host, port] = splitHostPort(req.url, 443)
    client.on('error', () => client.destroy())
    let route = null
    try { route = await routeFor(config(), resolveSystem, host, port, 'https') } catch (err) { fail(err) }
    const upstream = route
      ? net.connect(route.port, route.host)
      : net.connect(port, host)
    upstream.on('error', (err) => {
      fail(err)
      try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch { /* client gone */ }
      upstream.destroy()
    })
    const join = () => {
      if (head && head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    }
    if (!route) {
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        join()
      })
      return
    }
    upstream.on('connect', () => {
      let head1 = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`
      if (route.auth) head1 += `Proxy-Authorization: ${route.auth}\r\n`
      upstream.write(head1 + '\r\n')
    })
    // Read the upstream's CONNECT response before handing the socket over.
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) { if (buf.length > 64 * 1024) upstream.destroy(); return }
      upstream.removeListener('data', onData)
      const status = buf.slice(0, buf.indexOf('\r\n')).toString()
      const rest = buf.slice(end + 4)
      if (!/^HTTP\/1\.[01] 200/.test(status)) {
        try { client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n上游代理拒绝 CONNECT：${status}`) } catch { /* gone */ }
        upstream.destroy()
        return
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (rest.length) client.write(rest)
      join()
    }
    upstream.on('data', onData)
  }

  // Plain HTTP: proxy requests arrive in absolute form (GET http://h/p).
  async function onRequest(req, res) {
    let target
    try { target = new URL(req.url) } catch { res.writeHead(400); res.end(); return }
    const port = Number(target.port) || 80
    let route = null
    try { route = await routeFor(config(), resolveSystem, target.hostname, port, 'http') } catch (err) { fail(err) }
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    const opts = route
      ? { host: route.host, port: route.port, path: req.url, method: req.method, headers }
      : { host: target.hostname, port, path: target.pathname + target.search, method: req.method, headers }
    if (route && route.auth) opts.headers['proxy-authorization'] = route.auth
    const upstream = http.request(opts, (r) => {
      res.writeHead(r.statusCode || 502, r.headers)
      r.pipe(res)
    })
    upstream.on('error', (err) => {
      fail(err)
      try { res.writeHead(502); res.end() } catch { /* client gone */ }
    })
    req.pipe(upstream)
  }

  return new Promise((resolve) => {
    const server = http.createServer()
    server.on('request', (req, res) => { onRequest(req, res).catch(fail) })
    server.on('connect', (req, socket, head) => { onConnect(req, socket, head).catch((err) => { fail(err); socket.destroy() }) })
    server.on('clientError', (_err, socket) => { try { socket.destroy() } catch { /* gone */ } })
    server.on('error', (err) => { fail(err); resolve({ port: 0, close() {} }) })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close() { try { server.close() } catch { /* already down */ } },
      })
    })
  })
}

module.exports = { createForwarder, routeFor, splitHostPort }
