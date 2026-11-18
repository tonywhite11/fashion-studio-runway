/**
 * A real rigged GLB figure, wearing the same interface the game already uses
 * for its procedural one.
 *
 *     import { loadGlbCharacter } from './assets/characters/glb-character.js'
 *     const real = await loadGlbCharacter(THREE, { url: 'assets/characters/model.glb' })
 *     if (real) scene.add(real.group)        // null means carry on with the placeholder
 *
 * The game is live and children are using it, so loading is allowed to fail:
 * every entry point returns null or no-ops rather than throwing, and the caller
 * keeps the figure it already had.
 *
 * Interface mirrored from the Character class in index.html:
 *     .group .root .update(dt, walkPhase) .setSkin(i)
 * plus the parts a skinned GLB can actually honour:
 *     .poses .setPose(name, fade) .restPose()
 *
 * Not honoured, and honest about it: setOutfit / getGarment need each garment
 * authored as a skinned mesh bound to this same skeleton. A bare mannequin has
 * no clothes to switch, so those return null and the painter stays on the
 * procedural figure until real garments exist.
 */

const DEFAULTS = {
  url: 'assets/characters/model.glb',
  height: null,        // metres; rescales the rig to match the game's figure
  restClip: /mixamo\.com|Layer0|^t_?pose$/i,
}

/** Clip names that read as a figure standing on a runway rather than art reference. */
export const RUNWAY_POSES = ['female_standing_pose', 'female_locomotion_pose', 'male_locomotion_pose']

export async function loadGlbCharacter(THREE, options = {}) {
  const opt = { ...DEFAULTS, ...options }
  let GLTFLoader
  try {
    ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'))
  } catch (e) {
    console.warn('[glb-character] GLTFLoader unavailable:', e.message)
    return null
  }

  let gltf
  try {
    gltf = await new GLTFLoader().loadAsync(opt.url)
  } catch (e) {
    console.warn('[glb-character] could not load', opt.url, e.message)
    return null
  }

  const skinned = []
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o) })
  if (!skinned.length) {
    console.warn('[glb-character] no skinned mesh in', opt.url)
    return null
  }

  return new GlbCharacter(THREE, gltf, skinned, opt)
}

class GlbCharacter {
  constructor(THREE, gltf, skinned, opt) {
    this.THREE = THREE
    this.opt = opt
    this.skinned = skinned

    // root is what the runway moves; group is what goes in the scene. Keeping
    // them separate means a rescale here cannot fight the show's positioning.
    this.root = new THREE.Group()
    this.root.add(gltf.scene)
    this.group = new THREE.Group()
    this.group.add(this.root)

    this.clips = gltf.animations || []
    this.poses = this.clips.map((c) => c.name)
    this.mixer = new THREE.AnimationMixer(gltf.scene)
    this._current = null

    this.restClipName = (this.clips.find((c) => opt.restClip.test(c.name)) || this.clips[0] || {}).name || null

    if (opt.height) this.setHeight(opt.height)
    this._collectSkinMaterials()

    // Procedural gait by default: it is the motion the game already ships.
    // Clip mode is for browsing the pose library.
    this.walkAmt = 0
    this.walkScale = 1
    this.useClips = false
    if (!this._bindGait()) {
      console.warn("[glb-character] no Mixamo bones found; falling back to clips")
      this.useClips = true
      this.restPose()
    }
  }

  /** Match the game's figure height so camera framing and the runway still fit. */
  setHeight(metres) {
    const THREE = this.THREE
    this.root.scale.setScalar(1)
    this.root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(this.root)
    const h = box.getSize(new THREE.Vector3()).y
    if (h > 0.01) this.root.scale.setScalar(metres / h)
    return this
  }

  _collectSkinMaterials() {
    this._mats = []
    for (const m of this.skinned) {
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (mat && mat.color) this._mats.push(mat)
      }
    }
    this._baseColors = this._mats.map((m) => m.color.clone())
  }

  /**
   * Tint the body. Accepts a hex number or a THREE.Color. The game passes an
   * index into its own skin list, so callers should resolve that to a colour.
   */
  setSkin(color) {
    if (color == null) return this
    const c = new this.THREE.Color(color)
    this._mats.forEach((m, i) => m.color.copy(this._baseColors[i]).multiply(c))
    return this
  }

  resetSkin() {
    this._mats.forEach((m, i) => m.color.copy(this._baseColors[i]))
    return this
  }

  /** Crossfade to a named clip. Unknown names are ignored, not thrown. */
  setPose(name, fade = 0.35) {
    const clip = this.clips.find((c) => c.name === name)
    if (!clip) return false
    const next = this.mixer.clipAction(clip)
    next.reset()
    next.setLoop(this.THREE.LoopRepeat, Infinity)
    next.clampWhenFinished = true
    next.enabled = true
    // Mixamo pose files are a single frame; let them settle instead of looping
    // a zero-length clip, which some three versions spin on.
    if (clip.duration < 1e-3) next.play().paused = true
    else next.play()

    if (this._current && this._current !== next) this._current.crossFadeTo(next, fade, false)
    else next.setEffectiveWeight(1)
    this._current = next
    this.currentPose = name
    return true
  }

  restPose() {
    return this.restClipName ? this.setPose(this.restClipName, 0) : false
  }

  /**
   * Drive the rig the way index.html drives its procedural figure: one phase
   * scalar, sin/cos per joint, `walkAmt` blending idle to walk. The game's gait
   * is already tuned and parametric, so it is reused rather than replaced by a
   * keyframed clip, and the runway show keeps working unchanged.
   *
   * Set `walkAmt` (0..1) and `walkScale` on the instance, pass the same
   * `walkPhase` the show already computes.
   */
  update(dt, walkPhase = 0) {
    this.mixer.update(dt || 0)
    if (this.useClips) return

    const b = this._bones
    if (!b) return
    this._t = (this._t || 0) + (dt || 0)

    const t = this._t
    const w = this.walkAmt ?? 0
    const ws = this.walkScale ?? 1
    const idle = 1 - w
    const A = 0.5 * ws * w
    const sL = Math.sin(walkPhase)
    const sR = -sL
    // knee bends only through the swing half, same rectified cosine as the game
    const kf = (s) => (0.1 + 0.85 * Math.pow(Math.max(0, Math.cos(s)), 1.4)) * w * ws
    const breathe = Math.sin(t * 2.1)
    const sway = Math.sin(t * 1.15)

    // Offsets are ADDED to each bone's rest rotation, never assigned. The glTF
    // export bakes a -90 degree X correction into the root bone to make the rig
    // Y-up; assigning over it lays the whole figure flat on its face.
    const rest = this._rest
    const add = (key, x, y, z) => {
      const bone = b[key], r0 = rest[key]
      if (bone && r0) bone.rotation.set(r0.x + x, r0.y + y, r0.z + z)
    }

    const hy = Math.sin(walkPhase) * 0.13 * w
    if (b.hips && rest.hips) {
      add('hips', 0, hy, Math.sin(walkPhase) * 0.045 * w + sway * 0.02 * idle)
      b.hips.position.copy(this._hipsRest)
      b.hips.position.x += Math.sin(walkPhase) * 0.014 * w * this._unit
      b.hips.position.y += (-0.09 * A * Math.abs(Math.sin(walkPhase)) - 0.004 * breathe * idle) * this._unit
    }
    add('spine', 0, -hy * 0.9, -Math.sin(walkPhase) * 0.03 * w)
    add('spine1', 0, -hy * 0.3, 0.012 * breathe * idle)

    add('legL', -sL * A, 0, 0)
    add('legR', -sR * A, 0, 0)
    add('kneeL', kf(walkPhase), 0, 0)
    add('kneeR', kf(walkPhase + Math.PI), 0, 0)
    add('footL', sL * A * 0.35, 0, 0)
    add('footR', sR * A * 0.35, 0, 0)

    // A Mixamo rig rests in a T-pose, so the arms come down to the sides first
    // and the swing rides on top, or the figure walks like a scarecrow.
    //
    // Axes measured on the rig rather than assumed: +X lowers either arm, and
    // +Z swings the LEFT arm forward but the RIGHT one back, because the two
    // are mirrored. So one shared value gives the opposed swing a walk needs.
    const down = this.armDown ?? 1.3
    const swing = sL * 0.42 * w * ws + Math.sin(t * 1.3) * 0.02 * idle
    add('armL', down, 0, swing)
    add('armR', down, 0, swing)
    const elbow = 0.18 + 0.22 * w
    add('foreL', elbow, 0, 0)
    add('foreR', elbow, 0, 0)
  }

  /**
   * Resolve the handful of bones the gait needs, and remember their rest pose
   * so the walk is added to the T-pose rather than replacing it.
   */
  _bindGait() {
    const skel = this.skinned[0].skeleton
    // three's GLTFLoader puts node names through PropertyBinding.sanitizeNodeName,
    // which strips the colon: "mixamorig1:Hips" arrives as "mixamorig1Hips".
    const strip = (n) => n.replace(/^mixamorig\d*:?/, '')
    const find = (suffix) => skel.bones.find((x) => strip(x.name) === suffix) || null
    this._bones = {
      hips: find('Hips'), spine: find('Spine'), spine1: find('Spine1'),
      legL: find('LeftUpLeg'), legR: find('RightUpLeg'),
      kneeL: find('LeftLeg'), kneeR: find('RightLeg'),
      footL: find('LeftFoot'), footR: find('RightFoot'),
      armL: find('LeftArm'), armR: find('RightArm'),
      foreL: find('LeftForeArm'), foreR: find('RightForeArm'),
    }
    const THREE = this.THREE
    this._rest = {}
    for (const k in this._bones) {
      const bone = this._bones[k]
      this._rest[k] = bone ? bone.rotation.clone() : null
    }
    this._hipsRest = this._bones.hips ? this._bones.hips.position.clone() : new THREE.Vector3()

    // The hips bob is written in metres, but Mixamo rigs are authored in
    // centimetres, so bone-space translation needs the rig's own unit. Derive
    // it from the thigh, which on a human is about 0.42 m.
    const thigh = this._bones.kneeL ? this._bones.kneeL.position.length() : 0
    this._unit = thigh > 0 ? thigh / 0.42 : 1

    return !!this._bones.hips
  }

  /** Switch between the authored clips and the procedural gait. */
  useClipMode(on) {
    this.useClips = !!on
    if (!on) this.mixer.stopAllAction()
    return this
  }

  // --- garment hooks the game calls; a bare mannequin has nothing to switch ---
  setOutfit() { return false }
  getGarment() { return null }
  setHair() { return false }
  setEye() { return false }
  setShoe() { return false }
  setHairStyle() { return false }
  setAcc() { return false }

  dispose() {
    this.mixer.stopAllAction()
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      for (const m of [].concat(o.material || [])) {
        if (!m) continue
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) m[k]?.dispose?.()
        m.dispose?.()
      }
    })
  }
}
