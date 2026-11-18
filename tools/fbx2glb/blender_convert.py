#!/usr/bin/env python
"""
Runs inside Blender. Not meant to be run with a system python.

    blender --background --factory-startup --python blender_convert.py -- \
        --input in.fbx --output out.glb --mode character

Imports the FBX, exports a GLB, then re-imports that GLB into a clean scene and
measures both. The diff is the whole point: a converter that quietly drops the
skeleton, the blend shapes or the textures still writes a file that opens fine
and only fails later, in the game, with no clue why.

Writes one line to stdout prefixed with ###REPORT### containing JSON.
"""

import bpy
import sys
import os
import json
import argparse
import traceback
from mathutils import Vector


def argv_after_dashes():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def filtered_kwargs(op, kwargs):
    """Blender renames importer/exporter options between releases. Drop keys the
    installed version does not know rather than dying on them, and report which
    were dropped so a silently-ignored option cannot hide."""
    try:
        props = set(op.get_rna_type().properties.keys())
    except Exception:
        return dict(kwargs), []
    keep = {k: v for k, v in kwargs.items() if k in props}
    dropped = sorted(k for k in kwargs if k not in props)
    return keep, dropped


def measure():
    objs = list(bpy.data.objects)
    meshes = [o for o in objs if o.type == "MESH"]
    arms = [o for o in objs if o.type == "ARMATURE"]

    tris = 0
    verts = 0
    morphs = 0
    for o in meshes:
        me = o.data
        try:
            me.calc_loop_triangles()
            tris += len(me.loop_triangles)
        except Exception:
            tris += len(me.polygons)
        verts += len(me.vertices)
        if me.shape_keys and me.shape_keys.key_blocks:
            # the Basis key is not a morph target
            morphs += max(0, len(me.shape_keys.key_blocks) - 1)

    bones = sum(len(a.data.bones) for a in arms)

    skinned = 0
    for o in meshes:
        if any(m.type == "ARMATURE" for m in o.modifiers):
            skinned += 1
        elif o.parent is not None and o.parent.type == "ARMATURE":
            skinned += 1

    # Count what the meshes actually use, not every datablock. The FBX importer
    # routinely leaves spare material and image datablocks that nothing
    # references; glTF drops them, which is correct, and counting datablocks
    # reports that correct cleanup as data loss.
    used_mats = set()
    for o in meshes:
        for slot in o.material_slots:
            if slot.material is not None:
                used_mats.add(slot.material)

    # Only a texture wired into the material graph can be exported, by any tool.
    # FBX files routinely carry image nodes connected to nothing; counting those
    # as present makes every conversion look like it lost textures.
    images = set()
    orphans = set()
    for m in used_mats:
        if not m.use_nodes or m.node_tree is None:
            continue
        connected = {link.from_node for link in m.node_tree.links}
        for node in m.node_tree.nodes:
            img = getattr(node, "image", None)
            if img is None or img.name == "Render Result" or tuple(img.size) == (0, 0):
                continue
            (images if node in connected else orphans).add(img.name)

    # glTF stores alpha in the base colour image's A channel and has no slot for
    # a standalone alpha map, so one gets dropped. That is the format, not a
    # fault, but it is worth saying out loud instead of reporting a lost texture.
    separate_alpha = False
    for m in used_mats:
        if not m.use_nodes or m.node_tree is None:
            continue
        base_img = alpha_img = None
        for link in m.node_tree.links:
            img = getattr(link.from_node, "image", None)
            if img is None:
                continue
            if link.to_socket.name == "Base Color":
                base_img = img.name
            elif link.to_socket.name == "Alpha":
                alpha_img = img.name
        if base_img and alpha_img and base_img != alpha_img:
            separate_alpha = True

    actions = list(bpy.data.actions)
    frames = 0
    for a in actions:
        try:
            lo_f, hi_f = a.frame_range
            frames = max(frames, int(round(hi_f - lo_f)))
        except Exception:
            pass

    # Measure the rest shape from base vertices, not object.bound_box: bound_box
    # reflects whatever pose and morph values happen to be active, so the same
    # asset measures differently before and after the round-trip and the scale
    # check becomes meaningless.
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    seen = False
    for o in meshes:
        mw = o.matrix_world
        for v in o.data.vertices:
            w = mw @ v.co
            seen = True
            for i in range(3):
                if w[i] < lo[i]:
                    lo[i] = w[i]
                if w[i] > hi[i]:
                    hi[i] = w[i]
    dims = [round(hi[i] - lo[i], 4) for i in range(3)] if seen else [0.0, 0.0, 0.0]

    # A motion export is often skeleton only, with no geometry at all, so size
    # it by the bones instead. Without this such a file cannot be scale-checked.
    rlo = Vector((1e18, 1e18, 1e18))
    rhi = Vector((-1e18, -1e18, -1e18))
    rseen = False
    for a in arms:
        mw = a.matrix_world
        for b in a.data.bones:
            for p in (mw @ b.head_local, mw @ b.tail_local):
                rseen = True
                for i in range(3):
                    if p[i] < rlo[i]:
                        rlo[i] = p[i]
                    if p[i] > rhi[i]:
                        rhi[i] = p[i]
    rig_size = round(max(rhi[i] - rlo[i] for i in range(3)), 4) if rseen else 0.0

    return {
        "rigSize": rig_size,
        "meshes": len(meshes),
        "armatures": len(arms),
        "bones": bones,
        "skinnedMeshes": skinned,
        "vertices": verts,
        "triangles": tris,
        "morphTargets": morphs,
        "materials": len(used_mats),
        "images": len(images),
        "orphanImages": len(orphans),
        "separateAlphaTexture": separate_alpha,
        "actions": len(actions),
        "animFrames": frames,
        "dimensions": dims,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--mode", default="character",
                    choices=["character", "outfit", "motion"])
    # A number, or "auto" to measure the file and pick. One folder routinely
    # holds assets authored in different units, so a single --scale for a whole
    # batch is wrong as often as it is right.
    ap.add_argument("--scale", default="1.0")
    # Off by default: it is meant to strip the synthetic leaf bones some
    # exporters add, but it also eats the real end bone of a chain. Losing
    # bones silently is worse than carrying a few useless ones.
    ap.add_argument("--ignore-leaf-bones", action="store_true")
    args = ap.parse_args(argv_after_dashes())

    report = {
        "input": args.input,
        "output": args.output,
        "mode": args.mode,
        "ok": False,
        "warnings": [],
        "errors": [],
        "droppedOptions": [],
        "blender": bpy.app.version_string,
    }

    auto = str(args.scale).strip().lower() == "auto"
    scale = 1.0 if auto else float(args.scale)

    def do_import(s):
        reset_scene()
        imp = dict(
            filepath=args.input,
            use_image_search=True,
            # CC5 rigs import with mangled bone rolls without this
            automatic_bone_orientation=True,
            ignore_leaf_bones=args.ignore_leaf_bones,
            global_scale=s,
        )
        keep, dropped = filtered_kwargs(bpy.ops.import_scene.fbx, imp)
        bpy.ops.import_scene.fbx(**keep)
        return ["import." + d for d in dropped]

    report["droppedOptions"] += do_import(scale)

    if auto:
        # Size by geometry, or by the skeleton when the file is motion only.
        probe = measure()
        size = max(probe["dimensions"]) or probe["rigSize"]
        if size:
            if size < 0.5:
                scale = 100.0
            elif size > 4.0:
                scale = 0.01
        if scale != 1.0:
            do_import(scale)
    report["scaleUsed"] = scale
    report["before"] = measure()

    out_dir = os.path.dirname(os.path.abspath(args.output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    exp = dict(
        filepath=args.output,
        export_format="GLB",
        export_yup=True,
        export_apply=False,        # applying modifiers would collapse the armature
        export_skins=True,
        export_morph=True,
        export_animations=True,
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
    )
    keep, dropped = filtered_kwargs(bpy.ops.export_scene.gltf, exp)
    report["droppedOptions"] += ["export." + d for d in dropped]
    bpy.ops.export_scene.gltf(**keep)

    if not os.path.exists(args.output):
        report["errors"].append("exporter reported success but wrote no file")
        return report

    report["bytes"] = os.path.getsize(args.output)

    # The verification pass. Measuring the scene we exported FROM would only
    # confirm the import worked; re-reading the GLB is what catches loss.
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=args.output)
    report["after"] = measure()

    b, a = report["before"], report["after"]

    def lost(key, label):
        if b[key] > 0 and a[key] < b[key]:
            report["errors"].append("%s %d -> %d" % (label, b[key], a[key]))

    lost("bones", "bones lost:")
    lost("morphTargets", "morph targets lost:")
    lost("skinnedMeshes", "skinned meshes lost:")
    lost("materials", "materials lost:")

    if b["images"] > 0 and a["images"] < b["images"]:
        if b.get("separateAlphaTexture"):
            report["warnings"].append(
                "alpha was a separate texture; glTF keeps alpha in the base colour "
                "image, so the extra map was dropped. Combine them into one RGBA "
                "texture if this asset needs transparency")
        else:
            report["warnings"].append(
                "wired textures %d -> %d" % (b["images"], a["images"]))

    if b.get("orphanImages"):
        report["warnings"].append(
            "%d texture(s) present but wired to nothing, so no exporter can carry "
            "them (re-export with Embed Textures ON)" % b["orphanImages"])

    if b["triangles"] > 0:
        drift = abs(a["triangles"] - b["triangles"])
        if drift > max(1, b["triangles"] * 0.10):
            report["warnings"].append(
                "triangle count moved a lot: %d -> %d (a few percent is just retriangulation)" % (b["triangles"], a["triangles"]))

    if args.mode == "motion":
        if a["actions"] == 0:
            report["errors"].append("motion file carries no animation after conversion")
        elif a["animFrames"] < 2:
            report["warnings"].append(
                "animation is %d frames, likely a static pose" % a["animFrames"])

    if args.mode in ("character", "outfit"):
        # Judge scale on the FBX side: glTF stores skinned verts in bind space, so
        # the re-imported figure measures larger and is not comparable.
        h = (max(b["dimensions"]) if b["dimensions"] else 0.0) or b.get("rigSize", 0.0)
        if h > 0 and not (0.8 <= h <= 3.0):
            if h > 50:
                hint = " (looks like centimetres; try --scale 0.01)"
            elif h < 0.2:
                hint = " (looks like the source unit is tiny; try --scale 100)"
            else:
                hint = ""
            report["warnings"].append(
                "largest dimension %.3fm, expected 0.8-3.0m%s" % (h, hint))
        if a["bones"] == 0:
            report["warnings"].append(
                "no skeleton: fine for a prop, wrong for a character or outfit")

    report["ok"] = len(report["errors"]) == 0
    return report


if __name__ == "__main__":
    try:
        rep = main()
    except Exception:
        tb = traceback.format_exc()
        rep = {
            "ok": False,
            "errors": ["blender raised: " + tb.strip().splitlines()[-1]],
            "warnings": [],
            "traceback": tb,
        }
    sys.stdout.write("\n###REPORT###" + json.dumps(rep) + "\n")
    sys.stdout.flush()
