#!/usr/bin/env python
"""
Builds a small test FBX that has every feature the real CC5 exports have:
a skinned mesh, a bone chain, morph targets, a packed image texture and a
baked animation. Lets the converter be tested without waiting on CC5 assets.

    blender --background --factory-startup --python make_test_fbx.py -- --output test.fbx
"""

import bpy
import sys
import os
import argparse


def argv_after_dashes():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


ap = argparse.ArgumentParser()
ap.add_argument("--output", required=True)
args = ap.parse_args(argv_after_dashes())

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---- body: a 1.6 m cylinder, so the scale check has something plausible ----
bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.18, depth=1.6, location=(0, 0, 0.8))
body = bpy.context.object
body.name = "Body"

# more loops so armature weights actually deform something
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.subdivide(number_cuts=6)
bpy.ops.uv.smart_project(angle_limit=1.15)
bpy.ops.object.mode_set(mode="OBJECT")

# ---- rig: a five bone spine ----
arm_data = bpy.data.armatures.new("Rig")
arm_obj = bpy.data.objects.new("Rig", arm_data)
bpy.context.collection.objects.link(arm_obj)
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode="EDIT")
z = 0.0
prev = None
for name in ["hips", "spine", "chest", "neck", "head"]:
    b = arm_data.edit_bones.new(name)
    b.head = (0.0, 0.0, z)
    z += 0.32
    b.tail = (0.0, 0.0, z)
    if prev is not None:
        b.parent = prev
        b.use_connect = True
    prev = b
bpy.ops.object.mode_set(mode="OBJECT")

# ---- skinning ----
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
arm_obj.select_set(True)
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.parent_set(type="ARMATURE_AUTO")

# ---- morph targets ----
bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = body
body.shape_key_add(name="Basis")
for i, name in enumerate(["smile", "blink", "jaw_open"]):
    sk = body.shape_key_add(name=name)
    for j, v in enumerate(sk.data):
        if j % (i + 2) == 0:
            v.co.z += 0.015 * (i + 1)

# ---- material with a packed texture ----
img = bpy.data.images.new("TestTex", width=64, height=64)
px = [0.0] * (64 * 64 * 4)
for i in range(64 * 64):
    px[i * 4 + 0] = (i % 64) / 64.0
    px[i * 4 + 1] = (i // 64) / 64.0
    px[i * 4 + 2] = 0.5
    px[i * 4 + 3] = 1.0
img.pixels = px
img.pack()

mat = bpy.data.materials.new("BodyMat")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = img
mat.node_tree.links.new(bsdf.inputs["Base Color"], tex.outputs["Color"])
body.data.materials.append(mat)

# ---- animation ----
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode="POSE")
pb = arm_obj.pose.bones["spine"]
pb.rotation_mode = "XYZ"
for frame, angle in [(1, 0.0), (12, 0.35), (24, 0.0)]:
    scene.frame_set(frame)
    pb.rotation_euler = (angle, 0.0, 0.0)
    pb.keyframe_insert("rotation_euler", frame=frame)
bpy.ops.object.mode_set(mode="OBJECT")
scene.frame_start = 1
scene.frame_end = 24

out = os.path.abspath(args.output)
os.makedirs(os.path.dirname(out), exist_ok=True)
bpy.ops.export_scene.fbx(
    filepath=out,
    path_mode="COPY",
    embed_textures=True,
    add_leaf_bones=False,
    bake_anim=True,
)
print("WROTE %s (%d bytes)" % (out, os.path.getsize(out)))
