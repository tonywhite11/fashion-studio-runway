# Real model pipeline

How a rigged character goes from a studio FBX to something the game can load on
an iPad. Built and tested against the library in `D:\3D`.

```
  *.fbx  ──▶  tools/fbx2glb  ──▶  *.glb  ──▶  tools/prep-character  ──▶  assets/characters/model.glb
          convert + verify            pack: textures, pose clips            1.85 MB, one fetch
```

## 1. Convert

```powershell
node tools\fbx2glb\convert.mjs D:\3D\*.fbx --out D:\3D\glb
```

Converts via headless Blender and re-imports each GLB to check what survived.
Scale is picked per file. See `tools/fbx2glb/README.md`.

## 2. Pack

```powershell
& "C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe" --background --factory-startup `
  --python tools\prep-character\prep.py -- `
  --character D:\3D\glb\mannequin.glb --poses "D:\3D\glb\*Pose*.glb" `
  --output assets\characters\model.glb --texture 1024
```

Two problems this solves:

- **Weight.** `mannequin.glb` is 36.8 MB, and 35 MB of that is three
  uncompressed 4K PNGs. Resampled to 1024 and re-encoded as JPEG they are
  indistinguishable at the size this game draws them. **36.8 MB → 1.85 MB.**
- **Round trips.** Seventeen pose files is seventeen fetches. They all ride the
  same skeleton, so they fold into one GLB carrying seventeen named clips.

## 3. Use

```js
import { loadGlbCharacter } from './assets/characters/glb-character.js'

const real = await loadGlbCharacter(THREE, {
  url: 'assets/characters/model.glb',
  height: 1.72,                 // rescaled to match the game's figure
})
if (real) {
  scene.add(real.group)
  real.setPose('female_standing_pose')
}
// real === null means loading failed; keep the procedural Character
```

Loading never throws. If the GLB is missing, the loader is unavailable, or the
file has no skinned mesh, it returns `null` and the caller keeps the figure it
already had — the live game cannot be broken by a bad asset.

The module mirrors the interface documented at the top of `index.html`:
`.group`, `.root`, `.update(dt, walkPhase)`, `.setSkin()`, plus `.poses`,
`.setPose(name, fade)` and `.restPose()`.

## Look at what you have

```powershell
node tools\serve.mjs .          # then open http://localhost:5173/tools/prep-character/runway-demo.html
```

- `runway-demo.html` — the real figure on a runway, every clip as a button.
- `preview.html` — a contact sheet of all clips at once.
- `assets/characters/pose-sheet.html` — the same sheet with the model inlined,
  so it opens by double-clicking and can be sent to someone. Regenerate with
  `node tools\prep-character\make-posesheet.mjs`.

## What these assets can and cannot do

**They can** give the game a real 1.77 m rigged human: 65 Mixamo bones, one
skinned mesh, four textures, posed and crossfaded by clip name.

**They cannot** be dressed yet. `setOutfit` and `getGarment` return
`false`/`null` on purpose. Switching a dress needs each garment authored as its
own skinned mesh bound to *this same skeleton*; a bare mannequin has no clothes
to switch and the painter has no garment canvas to paint on. Until real garments
exist, the procedural `Character` stays the one the wardrobe talks to.

**The 17 poses are art reference, not runway poses.** Crouching, laying,
sitting, a star jump. Only `female_standing_pose`, `female_locomotion_pose` and
`male_locomotion_pose` read as a figure on a catwalk — they are flagged in
`RUNWAY_POSES`. None of the game's own nine gestures (wave, peace, finger
heart, namaste, twirl) are in this set. Those would come from Mixamo's
animation library proper, or from CC5.

## Skeletons

Every humanoid in `D:\3D` is the same Mixamo rig under different namespaces:

| file | joints | prefix |
|---|---|---|
| mannequin, all 17 poses | 65 | `mixamorig1:` |
| X Bot, Y Bot | 65 | `mixamorig:` |
| Doriorig | 57 | `mixamorig:` |

Strip the prefix and mannequin and the pose files match **65/65**, which is why
the clips apply with no retargeting at all. X Bot and Y Bot need the prefix
normalised first; Dorio is a different, smaller rig and would need real
retargeting (`SkeletonUtils.retargetClip`).

Dorio and the Koi are authored about 100× small — they import at 1.9 cm and
1.0 cm. `tools/fbx2glb` detects and corrects that per file.
