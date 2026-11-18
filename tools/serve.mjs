#!/usr/bin/env node
// Tiny static server for local preview. The game fetches a GLB, which file://
// will not allow, so it needs an origin even just to look at it.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve, normalize } from 'node:path'

const ROOT = resolve(process.argv[2] || '.')
const PORT = Number(process.env.PORT || 5173)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0])
    if (p.endsWith('/')) p += 'index.html'
    // never serve outside the root, whatever the path says
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''))
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return }
    const info = await stat(file)
    if (!info.isFile()) { res.writeHead(404).end('not found'); return }
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`))
