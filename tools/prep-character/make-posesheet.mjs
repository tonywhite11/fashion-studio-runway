#!/usr/bin/env node
/**
 * Bake preview.html plus the character GLB into one standalone file.
 *
 *   node tools/prep-character/make-posesheet.mjs
 *
 * The page normally fetches the GLB, which needs an http origin. Inlining it as
 * a data URI makes the sheet openable by double-clicking, and easy to send to
 * someone who just wants to look at the poses.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const model = process.argv[2] || join(ROOT, 'assets', 'characters', 'model.glb')
const out = process.argv[3] || join(ROOT, 'assets', 'characters', 'pose-sheet.html')

const glb = readFileSync(model)
const uri = 'data:model/gltf-binary;base64,' + glb.toString('base64')

let html = readFileSync(join(HERE, 'preview.html'), 'utf8')
if (!html.includes("'/assets/characters/model.glb'")) {
  console.error('preview.html no longer loads the expected path; not guessing')
  process.exit(1)
}
html = html.replace("'/assets/characters/model.glb'", 'MODEL_URI')
html = html.replace('<script type="module">', `<script>window.MODEL_URI=${JSON.stringify(uri)}</script>\n<script type="module">`)
html = html.replace('loader.loadAsync(MODEL_URI)', 'loader.loadAsync(window.MODEL_URI)')

writeFileSync(out, html)
console.log(`${out}  ${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB  (model ${(glb.length / 1048576).toFixed(2)} MB)`)
