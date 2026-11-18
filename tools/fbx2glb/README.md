# fbx2glb

Turns the CC5 exports in `assets/cc5/incoming/` into GLB the game can load, and
tells you what survived the trip.

```
node tools/fbx2glb/convert.mjs
```

That walks `assets/cc5/incoming/{character,outfits,motions}` and writes to
`assets/cc5/glb/`, mirroring the folder names.

```
node tools/fbx2glb/convert.mjs --list            # show what would run
node tools/fbx2glb/convert.mjs --only catwalk    # one file
node tools/fbx2glb/convert.mjs --scale 0.01      # override the automatic scale
node tools/fbx2glb/convert.mjs path/to/one.fbx --out build/
```

`--scale` defaults to **auto**: each file is probed on import, sized by its
geometry or by its skeleton if it has none, and converted at 1, 100 or 0.01 so
it lands at real-world metres. One folder routinely holds assets authored in
different units, so a single scale for a whole batch is wrong as often as it is
right. Pass a number to override.

Exit code is non-zero if any file failed, so it can gate a build.

## Why it is not a one-liner

Blender will happily convert an FBX and write a GLB that opens fine and is
missing the skeleton. You find out later, in the game, with no clue why.

So every file is converted and then **re-imported from the GLB** into a clean
scene and measured again. The report compares the two:

```
file           mesh   tris  bones  morphs  mats  tex   anim   size
character.glb     2  1,868      5       3     1    1  2/23f  0.1MB    ok
catwalk.glb       2  1,868      5       3     1    1  2/23f  0.1MB    ok
pose_hip.glb      2  1,868      5       3     1    0      -  0.1MB  FAIL

  FAIL  pose_hip.glb: motion file carries no animation after conversion
```

Hard failures (non-zero exit): bones, morph targets, skinned meshes or
materials lost between FBX and GLB; a file in `motions/` that arrives with no
animation. Warnings: textures lost, implausible scale, large triangle drift.

Two numbers that look alarming but are correct:

- **meshes and vertices go up.** glTF needs one vertex per unique
  normal/UV combination, so seams split. 896 → 1387 vertices is normal.
- **triangles drift a few percent.** The two formats triangulate n-gons
  differently. Only a >10% move is flagged.

## What the real files taught it

Run over the 26 FBX files in `D:\3D` — Mixamo rigs, a Reallusion character, a
rigged koi, 17 pose files. All 26 convert. Three things that look like bugs and
are not, each of which the checks had to learn to stop crying wolf about:

- **Spare datablocks.** The FBX importer leaves materials and images that
  nothing references. glTF drops them, correctly. Counting datablocks instead
  of what the meshes actually use reported that cleanup as `materials lost`
  on every single file that had one.
- **A separate alpha map.** glTF keeps alpha in the base colour image's A
  channel and has no slot for a standalone alpha texture, so one gets dropped.
  The koi hits this. It is the format, not the conversion.
- **Models that are 1.9 cm tall.** Dorio and Koi import at `0.019 m` because
  the object carries a 0.01 scale, while the Mixamo content in the same folder
  is already correct. Converting the lot at one `--scale` gets one group or the
  other wrong by 100×, which is why `auto` became the default.
- **Files with no mesh.** The 17 Mixamo pose exports are a 65-bone rig and a
  single frame, nothing else. Anything that sizes an asset by its geometry has
  to fall back to the skeleton or it cannot judge them at all.

The scale check reads the **FBX** side deliberately. glTF stores skinned
vertices in bind space, so the re-imported figure measures larger and the two
sides are not comparable; a 1.6 m test rig reads 2.6 m after the round trip.

## Blender

This is a wrapper around headless Blender; it does not ship a converter of its
own. Found via `$BLENDER`, then `PATH`, then the usual install locations. Steam
installs are discovered by reading `libraryfolders.vdf`, so a Blender sitting in
a library on another drive is found too.

```
winget install --id BlenderFoundation.Blender
```

If `winget` fails with a 403 — blender.org's CDN blocks some networks — use an
official mirror such as `https://ftp.nluug.nl/pub/graphics/blender/release/`,
or point at any copy you already have:

```powershell
$env:BLENDER = 'D:\Apps\Blender\blender.exe'
```

Verified on **Blender 4.5.5 LTS** and **5.3.0**, which produce identical
results and drop no options between them. Importer and exporter options are
filtered against what the installed Blender actually accepts, so a newer or
older build drops unknown options instead of crashing; `--verbose` lists any
that were dropped.

## Export settings that matter

From `docs/CC5-MVP-EXPORT-GUIDE.md`, the ones this tool cannot fix for you:

- **Embed Textures: ON.** Otherwise the GLB has no maps and you get a
  `textures 4 -> 0` warning.
- **Delete Hidden Faces: OFF.** Outfits are swapped at runtime, so the body
  has to stay whole.
- **In place** for motions. The game drives movement down the runway; root
  motion fights it.

`--ignore-leaf-bones` is **off** by default. It is meant to strip the synthetic
leaf bones some exporters add, but it also eats the real end bone of a chain —
it cost a bone on the test rig. Turn it on only if a CC5 skeleton arrives
visibly padded.

## Testing without CC5 assets

```
blender --background --factory-startup \
  --python tools/fbx2glb/make_test_fbx.py -- --output /tmp/character.fbx
```

Builds a 1.6 m rigged figure with a five bone spine, three morph targets, a
packed texture and a 24 frame animation — enough to exercise every check.
