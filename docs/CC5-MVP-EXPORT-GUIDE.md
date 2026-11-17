# CC5 MVP — export guide

Goal for the MVP: **one real Character Creator 5 character** on the runway, wearing **3 real 3D outfits**
that the girls customize with **colors, FashionGen prints/fabrics and decals** (no painting), with real
walk, pose and bow animations. Everything else in the game (closet, sharing, duo, announcer) stays.

You export from CC5 / iClone / FashionGen into `assets/cc5/incoming/…`. Claude converts everything to
web-ready files (GLB) with a Blender script — you don't need to learn Blender.

> Menu names below are from CC4/CC5 docs and may differ slightly in your version. If something
> doesn't match, send a screenshot of the dialog and we'll adjust.

---

## 0. One-time setup (10 minutes)
1. Install **Blender 4.2 LTS** (free): https://www.blender.org/download/lts/ — default install.
2. Install the free **CC/iC Blender Tools** add-on: https://github.com/soupday/cc_blender_tools
   (download the release ZIP → Blender → Edit → Preferences → Add-ons → Install from Disk → enable).
3. Tell Claude when both are installed; Claude checks them and runs all conversions.

## 1. The character (one file)
Build one stylized girl, about 8 years old, kid-friendly proportions.

- **Base layer:** dress her in a plain, close-fitting **base outfit** (e.g. a simple leotard or
  tank top + shorts). It stays on under every outfit so swapping clothes never shows bare body.
- **Hair:** one or two styles. Prefer **mesh/stylized hair** over strand/hair-card hair
  (hair cards render poorly and slowly in browsers).
- **Expressions:** keep the default CC facial morphs — we use them for Happy / Wink / Singing etc.
- **Polygon budget:** aim for under ~60k triangles total. If CC5 has a mesh-reduce / LOD option, use a
  medium level. Texture size **1024** (2048 only for the face).
- **Export:** File → Export → **FBX → Clothed Character**
  - Target Tool Preset: **Blender**
  - **Embed Textures: ON**
  - **Delete Hidden Faces: OFF** (outfits get swapped in the game, so the body must stay whole)
  - Include Motion: **Current Pose** (A-pose or T-pose)
  - Save as `assets/cc5/incoming/character/character.fbx`

## 2. Outfits (one file each)
Make **3 outfits** fitted to the *same* character. Suggestions:
`dress` (party / A-line), `gunyu` (Gunyu Cholo or Kurta Suruwal), `idol` (K-pop stage outfit).
Optional: **2 pairs of shoes**.

For each outfit:
1. Put it on the character (keep the base layer on underneath).
2. Give it a **white or very light base color** — the game tints it, and dark textures can't be tinted.
3. In **FashionGen → Color ID**, split the outfit into up to **4 zones** (e.g. main, skirt, sleeves,
   trim). Export the **Color ID map** as a PNG named `<outfit>_colorid.png` in
   `assets/cc5/incoming/outfits/`. The girls will recolor each zone separately.
4. Export the clothed character again (same settings as step 1) as
   `assets/cc5/incoming/outfits/<outfit>.fbx` (e.g. `dress.fbx`). Claude keeps only the outfit meshes.

## 3. Motions (iClone 8 or CC5 + ActorCore / Mixamo)
Apply each motion to the **same character** and export **motion FBX** (character + animation),
30 fps, **in place** (no forward root motion — the game moves her down the runway):

| File name | What |
|---|---|
| `idle.fbx` | relaxed standing loop (4–6 s) |
| `catwalk.fbx` | runway walk loop, in place |
| `turn.fbx` | 180° turn (about 1 s), optional — the game can rotate her instead |
| `pose_hip.fbx`, `pose_wave.fbx`, `pose_twirl.fbx` | three end-of-runway poses (2–3 s each) |
| `bow.fbx` | the finale bow |

Save them in `assets/cc5/incoming/motions/`. Keep all motions on the same skeleton (same character).

## 4. FashionGen print & decal pack
These become the choices on the girls' iPads.

- **Prints / fabrics (8–12):** tileable, 1024×1024 PNG → `assets/cc5/incoming/fashiongen/prints/`
  Ideas: Dhaka weave, lali gurans, lotus, Himalaya, marigold, K-pop neon, galaxy, ninja stripes,
  polka dots, florals, denim, sequins.
- **Decals (10–20):** transparent PNG, ~512×512 → `assets/cc5/incoming/fashiongen/decals/`
  Ideas: stars, hearts, a Nepal flag, diyo, kite, butterflies, a mic, a crown, their initials.
- Name files simply (`dhaka.png`, `star_gold.png`); the name becomes the label kids see.

## 5. Hand-off
When files are in `assets/cc5/incoming/`, tell Claude. Claude will:
1. Convert to `assets/cc5/character.glb` (body + outfits + hair, compressed) and `assets/cc5/motions.glb`.
2. Check size and speed on an iPad-sized budget (target: under ~15 MB total, loads in a few seconds).
3. Build the MVP on the `cc5-mvp` branch: real character on the runway, outfit picker, per-zone colors,
   prints, decals placed on the clothes, poses and bow — with the current doll kept as a fallback.

### Licensing check (before anything goes live)
The repo and site are public, so exported character, clothing and motion files can be downloaded by
anyone. Confirm your Reallusion / ActorCore / Mixamo licenses allow using them in a web game. If not,
the options are a private repo (GitHub Pages then needs a paid plan) or hosting the assets elsewhere.
