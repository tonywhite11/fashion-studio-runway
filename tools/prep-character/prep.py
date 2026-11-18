#!/usr/bin/env python
"""
Runs inside Blender. Builds one web-ready character GLB out of a rigged model
plus a folder of single-clip pose/animation files.

    blender --background --factory-startup --python prep.py -- \
        --character mannequin.glb --poses "D:/3D/glb/*Pose*.glb" \
        --output assets/characters/model.glb --texture 1024

Two things make the difference between a studio export and something a child can
load on an iPad over hotel wifi:

  * Textures. The mannequin ships three uncompressed 4K PNGs, 35 MB of the
    37 MB file. Resampled and re-encoded they cost a few hundred KB and look
    identical at the size this game draws them.
  * File count. Seventeen pose files is seventeen round trips. They all ride
    the same skeleton, so they collapse into one GLB with seventeen named
    animation clips and a single fetch.

Emits one line of JSON prefixed with ###PREP###.
"""

import bpy
import sys
import os
import re
import glob
import json
import argparse
import traceback


NS = re.compile(r"^mixamorig\d*:")
BONE_PATH = re.compile(r'pose\.bones\["([^"]+)"\](.*)')


def action_fcurves(action):
    """Blender 4.4 moved to slotted actions and dropped Action.fcurves, so the
    curves now hang off layers -> strips -> channelbags. Support both shapes."""
    legacy = getattr(action, "fcurves", None)
    if legacy is not None:
        return list(legacy)
    out = []
    for layer in getattr(action, "layers", []):
        for strip in getattr(layer, "strips", []):
            for bag in getattr(strip, "channelbags", []):
                out.extend(bag.fcurves)
    return out


def remap_action_bones(action, target_names):
    """Make a clip apply to a rig that uses a different bone namespace.

    Mixamo serves its library under `mixamorig:`, but a character uploaded and
    downloaded again comes back as `mixamorig1:`. Same 65 bones, same hierarchy,
    different prefix — so the clip silently animates nothing. Rewriting the
    fcurve paths is enough; this is not retargeting and will not rescue a rig
    whose bones genuinely differ.
    """
    lookup = {NS.sub("", n): n for n in target_names}
    hit = miss = 0
    for fc in action_fcurves(action):
        m = BONE_PATH.match(fc.data_path)
        if not m:
            continue
        src, rest = m.group(1), m.group(2)
        want = lookup.get(NS.sub("", src))
        if want is None:
            miss += 1
        elif want != src:
            fc.data_path = 'pose.bones["%s"]%s' % (want, rest)
            hit += 1
    return hit, miss


def argv_after_dashes():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def filtered(op, kwargs):
    try:
        props = set(op.get_rna_type().properties.keys())
    except Exception:
        return dict(kwargs), []
    return ({k: v for k, v in kwargs.items() if k in props},
            sorted(k for k in kwargs if k not in props))


def clip_name(path):
    name = os.path.splitext(os.path.basename(path))[0]
    # "Female Standing Pose (1)" -> "female_standing_pose_1"
    out = []
    for ch in name.lower():
        out.append(ch if ch.isalnum() else "_")
    return "_".join(x for x in "".join(out).split("_") if x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True)
    # repeatable, so pose sheets and walk cycles can come from different folders
    ap.add_argument("--poses", action="append", default=[])
    ap.add_argument("--output", required=True)
    ap.add_argument("--texture", type=int, default=1024)
    ap.add_argument("--quality", type=int, default=82)
    args = ap.parse_args(argv_after_dashes())

    report = {"ok": False, "warnings": [], "errors": [], "clips": [],
              "blender": bpy.app.version_string}

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.character)

    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not arms:
        report["errors"].append("character has no armature; nothing to pose")
        return report
    arm = arms[0]
    report["bones"] = len(arm.data.bones)
    report["boneSample"] = [b.name for b in arm.data.bones[:3]]

    # ---- textures ----
    before_px = 0
    after_px = 0
    for img in bpy.data.images:
        if img.name == "Render Result" or tuple(img.size) == (0, 0):
            continue
        w, h = img.size
        before_px += w * h
        if max(w, h) > args.texture:
            k = args.texture / float(max(w, h))
            img.scale(max(1, int(w * k)), max(1, int(h * k)))
        after_px += img.size[0] * img.size[1]
    report["texturesResampled"] = {"beforeMPx": round(before_px / 1e6, 2),
                                   "afterMPx": round(after_px / 1e6, 2)}

    # ---- pose clips ----
    # Every pose file carries its own copy of the skeleton. Keep only the
    # action; the armature it arrived on is thrown away.
    pose_files = sorted({p for pat in args.poses for p in glob.glob(pat)})
    for path in pose_files:
        known = set(bpy.data.actions)
        keep_objs = set(bpy.data.objects)
        try:
            bpy.ops.import_scene.gltf(filepath=path)
        except Exception as e:
            report["warnings"].append("%s: %s" % (os.path.basename(path), str(e)[:60]))
            continue

        fresh = [a for a in bpy.data.actions if a not in known]
        bone_names = [b.name for b in arm.data.bones]
        for a in fresh:
            # One clip per file: name it after the file, which is how the pose
            # sheets arrive. Several in one file: they already have real names
            # worth keeping, or they collide and Blender appends .001.
            a.name = clip_name(path) if len(fresh) == 1 else clip_name(a.name)
            a.use_fake_user = True          # survives having its owner deleted
            hit, miss = remap_action_bones(a, bone_names)
            if miss:
                report["warnings"].append(
                    "%s: %d curves target bones this rig does not have" % (a.name, miss))
            if hit:
                report.setdefault("remapped", {})[a.name] = hit
            report["clips"].append(a.name)

        for o in [o for o in bpy.data.objects if o not in keep_objs]:
            bpy.data.objects.remove(o, do_unlink=True)

    if pose_files and not report["clips"]:
        report["warnings"].append("pose files matched but produced no animation clips")

    # ACTIONS mode exports every action it can apply to the rig. Leaving one
    # assigned as the active action gets it exported under the armature's track
    # name instead of its own, which quietly breaks lookup by clip name.
    if report["clips"] and arm.animation_data is not None:
        arm.animation_data.action = None

    out = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    exp = dict(
        filepath=out,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_skins=True,
        export_morph=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_image_format="JPEG",
        export_jpeg_quality=args.quality,
        export_cameras=False,
        export_lights=False,
    )
    keep, dropped = filtered(bpy.ops.export_scene.gltf, exp)
    report["droppedOptions"] = dropped
    bpy.ops.export_scene.gltf(**keep)

    report["bytes"] = os.path.getsize(out)
    report["ok"] = not report["errors"]
    return report


if __name__ == "__main__":
    try:
        rep = main()
    except Exception:
        tb = traceback.format_exc()
        rep = {"ok": False, "warnings": [],
               "errors": ["blender raised: " + tb.strip().splitlines()[-1]],
               "traceback": tb}
    sys.stdout.write("\n###PREP###" + json.dumps(rep) + "\n")
    sys.stdout.flush()
