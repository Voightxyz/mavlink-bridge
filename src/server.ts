/**
 * Tiny local web server: serves the ground-station page and streams the
 * vehicle state to it over Server-Sent Events. No framework, no build step.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const INDEX = join(here, '..', 'public', 'index.html')

export interface ServerHooks {
  state: () => unknown
  /** Returns false when a new mission cannot start yet (aircraft still flying). */
  restart: () => boolean
}

export function startServer(port: number, hooks: ServerHooks) {
  const clients = new Set<ServerResponse>()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readFileSync(INDEX))
      return
    }
    if (url === '/assets/voight-mark.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' })
      res.end(readFileSync(join(here, '..', 'public', 'assets', 'voight-mark.svg')))
      return
    }
    if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify(hooks.state())}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(hooks.state()))
      return
    }
    if (url === '/restart') {
      const ok = hooks.restart()
      res.writeHead(ok ? 204 : 409, { 'content-type': 'text/plain' })
      res.end(ok ? '' : 'Aircraft still flying. Restart once it has landed.\n')
      return
    }
    res.writeHead(404)
    res.end()
  })

  server.listen(port)

  return {
    broadcast(state: unknown) {
      const line = `data: ${JSON.stringify(state)}\n\n`
      for (const c of clients) c.write(line)
    },
    close() {
      for (const c of clients) c.end()
      server.close()
    },
  }
}
