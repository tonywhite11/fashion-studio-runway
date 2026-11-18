#!/usr/bin/env python
"""
Author a runway walk directly on the character's own skeleton, so the game has
a walk cycle without anyone needing a Mixamo account.

    blender --background --factory-startup --python make-walk.py -- \
        --character D:/3D/glb/mannequin.glb --output D:/3D/walk/catwalk.glb

A catwalk is easier to hand-author than an ordinary walk: it is slow and
deliberate, the feet land on a single line rather than either side of one, the
hips carry the motion, and the arms barely move. Four keys per bone over a two
second loop is enough to read.

Writes a GLB holding the rig and the clips, ready to feed to prep.py like any
other animation source.
"""

import bpy
import sys
import os
import math
import json
import argparse
import traceback

R = math.radians


def argv_after_dashes():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def bone(arm, name):
    """Bones may be mixamorig: or mixamorig1: depending where the rig came from."""
    for pre in ("mixamorig1:", "mixamorig:", ""):
        pb = arm.pose.bones.get(pre + name)
        if pb:
            return pb
    return None


def key(arm, name, frame, rot=None, loc=None):
    pb = bone(arm, name)
    if pb is None:
        return False
    pb.rotation_mode = "XYZ"
    if rot is not None:
        pb.rotation_euler = (R(rot[0]), R(rot[1]), R(rot[2]))
        pb.keyframe_insert("rotation_euler", frame=frame)
    if loc is not None:
        pb.location = loc
        pb.keyframe_insert("location", frame=frame)
    return True


def build_walk(arm, fps, cycle):
    """One full cycle: left contact, left stance, right contact, right stance."""
    q = cycle / 4.0
    marks = [0, q, 2 * q, 3 * q, cycle]

    # Phase per leg. 0 = reaching forward, 2 = pushing back.
    def leg(side, phase):
        up, lo, ft = f"{side}UpLeg", f"{side}Leg", f"{side}Foot"
        for i, f in enumerate(marks):
            p = (i + phase) % 4
            if p == 0:      # heel reaching forward
                key(arm, up, f, (-26, 0, 0)); key(arm, lo, f, (12, 0, 0)); key(arm, ft, f, (8, 0, 0))
            elif p == 1:    # passing under the body, knee lifted
                key(arm, up, f, (6, 0, 0));   key(arm, lo, f, (42, 0, 0)); key(arm, ft, f, (-6, 0, 0))
            elif p == 2:    # driving back off the toe
                key(arm, up, f, (22, 0, 0));  key(arm, lo, f, (6, 0, 0));  key(arm, ft, f, (-16, 0, 0))
            else:           # lifting through
                key(arm, up, f, (-4, 0, 0));  key(arm, lo, f, (30, 0, 0)); key(arm, ft, f, (4, 0, 0))

    leg("Left", 0)
    leg("Right", 2)

    # Hips do the work: a drop onto each contact, sway over the stance leg, and
    # the twist that makes a runway walk read as a runway walk.
    for i, f in enumerate(marks):
        p = i % 4
        sway = (-0.035, 0.0, 0.035, 0.0)[p]
        drop = (-0.015, 0.012, -0.015, 0.012)[p]
        twist = (9, 0, -9, 0)[p]
        key(arm, "Hips", f, (0, twist, 0), (sway, drop, 0))

    # Shoulders counter-rotate against the hips.
    for i, f in enumerate(marks):
        twist = (-7, 0, 7, 0)[i % 4]
        key(arm, "Spine", f, (0, twist * 0.35, 0))
        key(arm, "Spine1", f, (0, twist * 0.4, 0))
        key(arm, "Spine2", f, (0, twist * 0.25, 0))
        key(arm, "Neck", f, (0, -twist * 0.3, 0))

    # Arms hang and swing a little, opposite the legs. Mixamo arms rest along
    # the T-pose, so the Z term is what brings them down to the sides.
    def arm_swing(side, phase, down):
        up, fore = f"{side}Arm", f"{side}ForeArm"
        for i, f in enumerate(marks):
            p = (i + phase) % 4
            sw = (-14, 0, 14, 0)[p]
            key(arm, up, f, (sw, 0, down))
            key(arm, fore, f, (max(0, sw * 0.5) + 10, 0, 0))

    arm_swing("Left", 2, 72)
    arm_swing("Right", 0, -72)


def build_idle(arm, cycle):
    """A quiet standing breath, for the top of the runway."""
    marks = [0, cycle / 2.0, cycle]
    for i, f in enumerate(marks):
        up = (0, 1, 0)[i % 3] if i < 3 else 0
        key(arm, "Hips", f, (0, 0, 0), (0, 0.006 if i == 1 else 0, 0))
        key(arm, "Spine1", f, (-1.5 if i == 1 else 0, 0, 0))
        key(arm, "LeftArm", f, (0, 0, 74 if i == 1 else 72))
        key(arm, "RightArm", f, (0, 0, -74 if i == 1 else -72))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--cycle", type=int, default=60)   # frames for one full walk
    args = ap.parse_args(argv_after_dashes())

    report = {"ok": False, "clips": [], "warnings": [], "errors": [],
              "blender": bpy.app.version_string}

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.character)
    bpy.context.scene.render.fps = args.fps

    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not arms:
        report["errors"].append("no armature in the character file")
        return report
    arm = arms[0]
    bpy.context.view_layer.objects.active = arm

    if bone(arm, "Hips") is None:
        report["errors"].append("this rig has no Hips bone; not a Mixamo skeleton")
        return report

    for name, fn, length in (("catwalk_walk", build_walk, args.cycle),
                             ("catwalk_idle", build_idle, args.cycle)):
        # start each clip from a clean pose so they do not inherit each other
        bpy.ops.object.mode_set(mode="POSE")
        bpy.ops.pose.select_all(action="SELECT")
        bpy.ops.pose.transforms_clear()
        bpy.ops.object.mode_set(mode="OBJECT")

        arm.animation_data_create()
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        arm.animation_data.action = act
        if fn is build_walk:
            fn(arm, args.fps, length)
        else:
            fn(arm, length)
        report["clips"].append(name)

    arm.animation_data.action = None

    out = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format="GLB", export_yup=True,
        export_skins=True, export_animations=True,
        export_animation_mode="ACTIONS", export_image_format="NONE",
        export_cameras=False, export_lights=False,
    )
    report["bytes"] = os.path.getsize(out)
    report["ok"] = not report["errors"]
    return report


if __name__ == "__main__":
    try:
        rep = main()
    except Exception:
        tb = traceback.format_exc()
        rep = {"ok": False, "warnings": [], "clips": [],
               "errors": ["blender raised: " + tb.strip().splitlines()[-1]], "traceback": tb}
    sys.stdout.write("\n###WALK###" + json.dumps(rep) + "\n")
    sys.stdout.flush()
