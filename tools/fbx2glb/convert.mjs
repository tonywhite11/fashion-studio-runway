#!/usr/bin/env node
/**
 * Batch FBX -> GLB for the CC5 assets, via headless Blender.
 *
 *   node tools/fbx2glb/convert.mjs                 # everything in assets/cc5/incoming
 *   node tools/fbx2glb/convert.mjs --only catwalk  # just the files matching
 *   node tools/fbx2glb/convert.mjs --scale 0.01    # CC5 exported in centimetres
 *   node tools/fbx2glb/convert.mjs --list          # show what would run, convert nothing
 *
 * Blender does the actual work (see blender_convert.py). This part finds
 * Blender, decides the mode per folder, runs one child process per file, and
 * turns the JSON reports into a table where a file that lost its skeleton is
 * impossible to miss.
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PY = join(HERE, 'blender_convert.py')

const IN_ROOT = join(ROOT, 'assets', 'cc5', 'incoming')
const OUT_ROOT = join(ROOT, 'assets', 'cc5', 'glb')

// folder name -> how the verifier should judge the result
const MODES = { character: 'character', outfits: 'outfit', motions: 'motion' }

/* ------------------------------- cli ------------------------------- */

function parseArgs(argv) {
  const o = { only: null, scale: 'auto', list: false, verbose: false, out: OUT_ROOT, inputs: [], ignoreLeafBones: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') o.only = argv[++i]
    else if (a === '--scale') o.scale = argv[++i]
    else if (a === '--ignore-leaf-bones') o.ignoreLeafBones = true
    else if (a === '--out') o.out = resolve(argv[++i])
    else if (a === '--list' || a === '--dry-run') o.list = true
    else if (a === '--verbose' || a === '-v') o.verbose = true
    else if (a === '--help' || a === '-h') { usage(); process.exit(0) }
    else if (a.startsWith('-')) { console.error(`unknown flag ${a}`); process.exit(2) }
    else o.inputs.push(a)
  }
  if (String(o.scale).toLowerCase() !== 'auto' && !(Number(o.scale) > 0)) {
    console.error('--scale must be a positive number, or "auto"')
    process.exit(2)
  }
  return o
}

function usage() {
  console.log(`
fbx2glb - convert the CC5 exports into GLB the game can load

  node tools/fbx2glb/convert.mjs [files...] [options]

  --only <text>   only files whose name contains <text>
  --scale <n>     FBX import scale, or "auto" (default) to measure each file
                  and pick 1 / 100 / 0.01 per file
  --out <dir>     output root (default assets/cc5/glb)
  --ignore-leaf-bones
                  strip exporter-added leaf bones. Off by default because it
                  also eats the real end bone of a chain
  --list          show what would run, convert nothing
  --verbose       stream Blender's own output
  --help

  Blender is found via the BLENDER env var, then PATH, then the usual
  install locations.
`)
}

/* ----------------------------- blender ----------------------------- */

/**
 * Steam installs to whichever library the user picked, which is routinely on a
 * different drive, and the client itself lives under "Program Files (x86)" on
 * most machines. Ask Steam where its libraries are rather than guessing.
 */
function steamBlenderDirs() {
  const bases = [
    'C:/Program Files (x86)/Steam',
    'C:/Program Files/Steam',
    process.env.HOME ? join(process.env.HOME, '.steam', 'steam') : null,
    process.env.HOME ? join(process.env.HOME, 'Library', 'Application Support', 'Steam') : null,
  ].filter(Boolean)

  const libraries = new Set()
  for (const base of bases) {
    if (existsSync(join(base, 'steamapps'))) libraries.add(base)
    const vdf = join(base, 'steamapps', 'libraryfolders.vdf')
    if (!existsSync(vdf)) continue
    try {
      const text = readFileSync(vdf, 'utf8')
      for (const m of text.matchAll(/"path"\s*"([^"]+)"/g)) {
        libraries.add(m[1].replace(/\\\\/g, '/').replace(/\\/g, '/'))
      }
    } catch { /* unreadable config, fall back to the defaults above */ }
  }
  return [...libraries].map((lib) => join(lib, 'steamapps', 'common', 'Blender'))
}

function findBlender() {
  if (process.env.BLENDER && existsSync(process.env.BLENDER)) return process.env.BLENDER

  const roots = [
    'C:/Program Files/Blender Foundation',
    'C:/Program Files (x86)/Blender Foundation',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Blender Foundation') : null,
    ...steamBlenderDirs(),
    '/Applications/Blender.app/Contents/MacOS',
    '/usr/bin',
    '/usr/local/bin',
  ].filter(Boolean)

  const names = process.platform === 'win32' ? ['blender.exe'] : ['Blender', 'blender']
  const found = []

  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const n of names) {
      const direct = join(root, n)
      if (existsSync(direct)) found.push(direct)
    }
    // Blender installs as "Blender Foundation/Blender 4.2/blender.exe"
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { /* unreadable */ }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      for (const n of names) {
        const p = join(root, e.name, n)
        if (existsSync(p)) found.push(p)
      }
    }
  }
  // newest version string wins
  found.sort()
  return found.length ? found[found.length - 1] : null
}

function blenderMissing() {
  console.error(`
Blender not found, and this tool is a wrapper around it.

  winget install --id BlenderFoundation.Blender

Then re-run. If it is installed somewhere unusual, point at it directly:

  set BLENDER=D:\\Apps\\Blender\\blender.exe        (cmd)
  $env:BLENDER = 'D:\\Apps\\Blender\\blender.exe'   (PowerShell)
`)
}

/* ------------------------------ inputs ----------------------------- */

function collect(opts) {
  const jobs = []

  if (opts.inputs.length) {
    for (const p of opts.inputs) {
      const abs = resolve(p)
      if (!existsSync(abs)) { console.error(`no such file: ${p}`); process.exit(2) }
      jobs.push({ src: abs, mode: guessMode(abs), out: join(opts.out, basename(abs).replace(/\.fbx$/i, '.glb')) })
    }
    return jobs
  }

  if (!existsSync(IN_ROOT)) {
    console.error(`nothing to convert: ${IN_ROOT} does not exist`)
    process.exit(2)
  }

  for (const [folder, mode] of Object.entries(MODES)) {
    const dir = join(IN_ROOT, folder)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!/\.fbx$/i.test(name)) continue
      const src = join(dir, name)
      if (!statSync(src).isFile()) continue
      if (opts.only && !name.toLowerCase().includes(opts.only.toLowerCase())) continue
      jobs.push({ src, mode, out: join(opts.out, folder, name.replace(/\.fbx$/i, '.glb')) })
    }
  }
  return jobs
}

// Only used for files named on the command line; the batch walk takes the mode
// from the folder. The words come from CC5-MVP-EXPORT-GUIDE.md, which calls the
// motion files idle / catwalk / turn / pose_* / bow, none of which say "motion".
const MOTION_WORDS = /motion|idle|walk|run|turn|pose|bow|anim|dance|jump|crouch|sit|lay/
const OUTFIT_WORDS = /outfit|dress|gunyu|kurta|cholo|suruwal|shoe|costume/

function guessMode(p) {
  const s = basename(p).toLowerCase()
  if (MOTION_WORDS.test(s)) return 'motion'
  if (OUTFIT_WORDS.test(s)) return 'outfit'
  return 'character'
}

/* ------------------------------- run ------------------------------- */

function runOne(blender, job, opts) {
  return new Promise((done) => {
    const args = [
      '--background', '--factory-startup',
      '--python', PY, '--',
      '--input', job.src,
      '--output', job.out,
      '--mode', job.mode,
      '--scale', String(opts.scale),
      ...(opts.ignoreLeafBones ? ['--ignore-leaf-bones'] : []),
    ]
    const child = spawn(blender, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
      if (opts.verbose) process.stdout.write(d)
    })
    child.stderr.on('data', (d) => {
      err += d
      if (opts.verbose) process.stderr.write(d)
    })
    child.on('error', (e) => done({ ok: false, errors: [`could not start Blender: ${e.message}`], warnings: [] }))
    child.on('close', (code) => {
      const marker = out.lastIndexOf('###REPORT###')
      if (marker === -1) {
        const tail = (err || out).trim().split('\n').slice(-4).join('\n')
        return done({
          ok: false,
          warnings: [],
          errors: [`Blender exited ${code} without a report`, tail].filter(Boolean),
        })
      }
      try {
        done(JSON.parse(out.slice(marker + '###REPORT###'.length).split('\n')[0]))
      } catch (e) {
        done({ ok: false, warnings: [], errors: [`unreadable report: ${e.message}`] })
      }
    })
  })
}

/* ----------------------------- output ------------------------------ */

const n = (v) => (v === undefined || v === null ? '-' : String(v))
const mb = (b) => (b ? (b / 1048576).toFixed(1) + 'MB' : '-')

function table(rows) {
  const head = ['file', 'mesh', 'tris', 'bones', 'morphs', 'mats', 'tex', 'anim', 'size', '']
  const body = rows.map((r) => {
    const a = r.report.after || r.report.before || {}
    return [
      r.name,
      n(a.meshes),
      a.triangles ? a.triangles.toLocaleString('en-US') : '-',
      n(a.bones),
      n(a.morphTargets),
      n(a.materials),
      n(a.images),
      a.actions ? `${a.actions}/${a.animFrames}f` : '-',
      mb(r.report.bytes),
      r.report.ok ? (r.report.warnings.length ? 'warn' : 'ok') : 'FAIL',
    ]
  })
  const all = [head, ...body]
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)))
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ')
  console.log('\n' + line(head))
  console.log(w.map((x) => '-'.repeat(x)).join('  '))
  for (const r of body) console.log(line(r))
}

/* ------------------------------- main ------------------------------ */

const opts = parseArgs(process.argv.slice(2))
const blender = findBlender()
if (!blender) { blenderMissing(); process.exit(1) }

const jobs = collect(opts)
if (!jobs.length) {
  console.log(`No .fbx files found under ${relative(process.cwd(), IN_ROOT) || IN_ROOT}.`)
  console.log('Export from CC5 first; see docs/CC5-MVP-EXPORT-GUIDE.md.')
  process.exit(0)
}

console.log(`blender: ${blender}`)
console.log(`${jobs.length} file${jobs.length === 1 ? '' : 's'} -> ${opts.out}`)

if (opts.list) {
  for (const j of jobs) console.log(`  [${j.mode}] ${relative(ROOT, j.src)}`)
  process.exit(0)
}

mkdirSync(opts.out, { recursive: true })

const rows = []
for (const job of jobs) {
  const name = basename(job.src)
  process.stdout.write(`  ${name} ... `)
  const report = await runOne(blender, job, opts)
  process.stdout.write(report.ok ? (report.warnings.length ? 'warn\n' : 'ok\n') : 'FAIL\n')
  rows.push({ name: name.replace(/\.fbx$/i, '.glb'), report })
}

table(rows)

const notes = rows.filter((r) => r.report.warnings.length || r.report.errors.length)
if (notes.length) {
  console.log('')
  for (const r of notes) {
    for (const e of r.report.errors) console.log(`  FAIL  ${r.name}: ${e}`)
    for (const wmsg of r.report.warnings) console.log(`  warn  ${r.name}: ${wmsg}`)
    const dropped = r.report.droppedOptions || []
    if (dropped.length && opts.verbose) {
      console.log(`  note  ${r.name}: this Blender ignored ${dropped.join(', ')}`)
    }
  }
}

const failed = rows.filter((r) => !r.report.ok).length
console.log(`\n${rows.length - failed}/${rows.length} converted`)
process.exit(failed ? 1 : 0)
