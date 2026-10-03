import * as THREE from 'three'
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// ─────────────────────────────────────────────────────────────────────────────
// World: sim metres (x east, y north, alt up) → three.js (x, up, -z)
// ─────────────────────────────────────────────────────────────────────────────
const V = THREE.Vector3
const W = (x, y, alt = 0) => new V(x - 500, alt, -(y - 500))
const DRONE_SCALE = 3.0 // drawn larger than life so the aircraft reads on screen
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

// Site layout (static; the mission supplies home, waypoints, assets and the NFZ)
const BUILDINGS = [
  { x: 380, y: 330, w: 92, d: 58, h: 18, lit: true },
  { x: 640, y: 320, w: 110, d: 70, h: 26, lit: true },
  { x: 690, y: 625, w: 80, d: 78, h: 31, lit: true },
  { x: 360, y: 640, w: 120, d: 58, h: 14, lit: false },
  { x: 295, y: 480, w: 50, d: 90, h: 22, lit: true },
  { x: 712, y: 460, w: 56, d: 48, h: 12, lit: false },
  { x: 560, y: 665, w: 70, d: 40, h: 16, lit: true },
]
const ROADS = [
  [[230, 240], [760, 240], [760, 700], [230, 700], [230, 240]],
  [[-250, 470], [230, 470]],
  [[230, 240], [150, 160]],
  [[760, 240], [800, 205]],
  [[760, 700], [832, 772]],
  [[230, 700], [168, 830]],
]
const FENCE = { x0: 40, y0: 60, x1: 960, y1: 940 }

// ─────────────────────────────────────────────────────────────────────────────
// Renderer, scene, post-processing
// ─────────────────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.1
document.getElementById('scene').appendChild(renderer.domElement)

const labels = new CSS2DRenderer()
labels.setSize(innerWidth, innerHeight)
Object.assign(labels.domElement.style, { position: 'fixed', top: '0', left: '0', pointerEvents: 'none', zIndex: '2' })
document.body.appendChild(labels.domElement)

const scene = new THREE.Scene()
const HORIZON = new THREE.Color(0x1b2230)
scene.fog = new THREE.Fog(HORIZON, 900, 3200)

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.5, 9000)
camera.position.set(-900, 520, 900)
const RAIL = 360
function applyViewOffset() {
  const hud = innerWidth > 980 ? RAIL : 0
  camera.aspect = (innerWidth + hud) / innerHeight
  camera.setViewOffset(innerWidth + hud, innerHeight, hud, 0, innerWidth, innerHeight)
  camera.updateProjectionMatrix()
}
applyViewOffset()

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.35, 0.86)
composer.addPass(bloom)
composer.addPass(new OutputPass())

// sky dome: blue-hour gradient
{
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(6000, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x04060a) }, horizon: { value: HORIZON }, glow: { value: new THREE.Color(0x3a2c26) }, sunDir: { value: new V(-0.8, 0.12, 0.55).normalize() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 glow; uniform vec3 sunDir; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y, -0.2, 1.0); vec3 c = mix(horizon, top, smoothstep(0.0, 0.55, h));
          float s = pow(max(dot(normalize(vec3(vDir.x,0.0,vDir.z)), normalize(vec3(sunDir.x,0.0,sunDir.z))), 0.0), 6.0) * (1.0 - smoothstep(0.0, 0.25, h));
          c += glow * s * 0.9; gl_FragColor = vec4(c, 1.0); }`,
    }),
  )
  scene.add(sky)
}

// lights: low warm key for long shadows, cool fill
scene.add(new THREE.HemisphereLight(0xa9b9d8, 0x1a1712, 0.62))
const sun = new THREE.DirectionalLight(0xffd2a6, 2.1)
sun.position.set(-620, 300, 420)
sun.castShadow = true
sun.shadow.mapSize.set(4096, 4096)
Object.assign(sun.shadow.camera, { left: -820, right: 820, top: 820, bottom: -820, near: 50, far: 2200 })
sun.shadow.bias = -0.0003
sun.shadow.normalBias = 0.6
scene.add(sun)
const fill = new THREE.DirectionalLight(0x7f9cc9, 0.38)
fill.position.set(520, 320, -420)
scene.add(fill)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function tag(html, cls = '') { const el = document.createElement('div'); el.className = 'tag ' + cls; el.innerHTML = html; return new CSS2DObject(el) }
function beam(a, b, t) {
  const g = new THREE.BoxGeometry(t, t, a.distanceTo(b))
  const q = new THREE.Quaternion().setFromUnitVectors(new V(0, 0, 1), b.clone().sub(a).normalize())
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new V(1, 1, 1)))
  return g
}
const mats = {
  wall: new THREE.MeshStandardMaterial({ color: 0x3b3e45, roughness: 0.92 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x2a2d32, roughness: 0.85 }),
  unit: new THREE.MeshStandardMaterial({ color: 0x51555d, roughness: 0.6, metalness: 0.3 }),
  door: new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.7 }),
  winLit: new THREE.MeshStandardMaterial({ color: 0x15130f, emissive: 0xffcf8f, emissiveIntensity: 1.5 }),
  winDark: new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.3, metalness: 0.6 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x5b6069, roughness: 0.5, metalness: 0.6 }),
  tank: new THREE.MeshStandardMaterial({ color: 0xa4a9b1, roughness: 0.38, metalness: 0.55 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x777a81, roughness: 1, side: THREE.DoubleSide }),
  crane: new THREE.MeshStandardMaterial({ color: 0xd6a419, roughness: 0.55, metalness: 0.3 }),
  edge: new THREE.LineBasicMaterial({ color: 0x5c606a, transparent: true, opacity: 0.35 }),
}
const blinkers = [] // aviation lights: { mesh, phase, period }
function aviationLight(pos, color = 0xff3b30, size = 0.7, period = 1.2) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color }))
  m.position.copy(pos)
  scene.add(m)
  blinkers.push({ mesh: m, phase: Math.random() * period, period, base: new THREE.Color(color) })
  return m
}

// ─────────────────────────────────────────────────────────────────────────────
// Ground: procedural site texture (yard, roads, pads, helipad, fence)
// ─────────────────────────────────────────────────────────────────────────────
function buildGround(mission) {
  const SITE = { x0: -250, y0: -250, size: 1500 }, PX = 2048, s = PX / SITE.size
  const cv = document.createElement('canvas'); cv.width = cv.height = PX
  const g = cv.getContext('2d')
  const X = (x) => (x - SITE.x0) * s, Y = (y) => (SITE.y0 + SITE.size - y) * s
  const r = rng(7)
  g.fillStyle = '#16181b'; g.fillRect(0, 0, PX, PX)
  for (let i = 0; i < 90; i++) { // vegetation and dirt patches
    const x = r() * PX, y = r() * PX, rad = (40 + r() * 170) * s
    const gr = g.createRadialGradient(x, y, 0, x, y, rad)
    const c = r() < 0.6 ? 'rgba(30,38,31,0.42)' : 'rgba(42,39,33,0.3)'
    gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2)
  }
  // yard inside the fence
  g.fillStyle = 'rgba(28,30,33,0.85)'; g.fillRect(X(FENCE.x0), Y(FENCE.y1), (FENCE.x1 - FENCE.x0) * s, (FENCE.y1 - FENCE.y0) * s)
  for (let i = 0; i < 160000; i++) { const v = r() < 0.5 ? 255 : 0; g.fillStyle = `rgba(${v},${v},${v},${0.018 + r() * 0.02})`; g.fillRect(r() * PX, r() * PX, 1 + r() * 1.5, 1 + r() * 1.5) }
  // survey grid
  g.strokeStyle = 'rgba(255,255,255,0.028)'; g.lineWidth = 1
  for (let v = -200; v <= 1200; v += 100) { g.beginPath(); g.moveTo(X(v), 0); g.lineTo(X(v), PX); g.stroke(); g.beginPath(); g.moveTo(0, Y(v)); g.lineTo(PX, Y(v)); g.stroke() }
  // building pads
  g.fillStyle = '#24272c'
  for (const b of BUILDINGS) g.fillRect(X(b.x - b.w / 2 - 6), Y(b.y + b.d / 2 + 6), (b.w + 12) * s, (b.d + 12) * s)
  // roads
  g.lineCap = 'round'; g.lineJoin = 'round'
  const path = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))) }
  for (const rd of ROADS) { path(rd); g.strokeStyle = '#202227'; g.lineWidth = 11 * s; g.stroke() }
  for (const rd of ROADS) { path(rd); g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 11 * s; g.setLineDash([]); g.stroke(); path(rd); g.strokeStyle = '#202227'; g.lineWidth = 10 * s; g.stroke() }
  g.setLineDash([5 * s, 5 * s]); g.strokeStyle = 'rgba(210,214,220,0.32)'; g.lineWidth = 0.35 * s
  for (const rd of ROADS) { path(rd); g.stroke() }
  g.setLineDash([])
  // parking
  g.fillStyle = '#1f2125'; g.fillRect(X(645), Y(575), 60 * s, 45 * s)
  g.strokeStyle = 'rgba(220,224,230,0.22)'; g.lineWidth = 0.3 * s
  for (let x = 648; x <= 702; x += 3) { g.beginPath(); g.moveTo(X(x), Y(575)); g.lineTo(X(x), Y(569)); g.stroke(); g.beginPath(); g.moveTo(X(x), Y(536)); g.lineTo(X(x), Y(530)); g.stroke() }
  // crane foundation, tank bund, stack and tower pads
  const o = mission.obstacles[0]; if (o) { g.fillStyle = '#2a2d32'; g.fillRect(X(o.x - 9), Y(o.y + 9), 18 * s, 18 * s) }
  for (const wp of mission.waypoints) {
    const a = wp.asset
    if (a.kind === 'tanks') { g.fillStyle = '#1a1c1f'; g.fillRect(X(a.x - 38), Y(a.y + 38), 76 * s, 76 * s); g.strokeStyle = '#33363c'; g.lineWidth = 2.4 * s; g.strokeRect(X(a.x - 38), Y(a.y + 38), 76 * s, 76 * s) }
    if (a.kind === 'stack') { g.fillStyle = '#25282d'; g.fillRect(X(a.x - 10), Y(a.y + 10), 20 * s, 20 * s) }
    if (a.kind === 'cooling') { g.fillStyle = '#1e2024'; g.beginPath(); g.arc(X(a.x), Y(a.y), 32 * s, 0, Math.PI * 2); g.fill() }
  }
  // helipad (home)
  const b = mission.base
  g.fillStyle = '#2b2e34'; g.fillRect(X(b.x - 22), Y(b.y + 22), 44 * s, 44 * s)
  g.strokeStyle = 'rgba(232,234,238,0.6)'; g.lineWidth = 0.8 * s; g.beginPath(); g.arc(X(b.x), Y(b.y), 14 * s, 0, Math.PI * 2); g.stroke()
  g.fillStyle = 'rgba(232,234,238,0.62)'; g.font = `600 ${17 * s}px Inter, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', X(b.x), Y(b.y) + 0.5 * s)
  g.strokeStyle = 'rgba(227,180,92,0.55)'; g.lineWidth = 0.6 * s; g.strokeRect(X(b.x - 21), Y(b.y + 21), 42 * s, 42 * s)
  // perimeter fence
  g.strokeStyle = 'rgba(205,210,220,0.16)'; g.lineWidth = 0.6 * s; g.setLineDash([2 * s, 1.2 * s])
  g.strokeRect(X(FENCE.x0), Y(FENCE.y1), (FENCE.x1 - FENCE.x0) * s, (FENCE.y1 - FENCE.y0) * s); g.setLineDash([])

  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  const site = new THREE.Mesh(new THREE.PlaneGeometry(SITE.size, SITE.size), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }))
  site.rotation.x = -Math.PI / 2
  site.receiveShadow = true
  scene.add(site)
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000), new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 1 }))
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.2; outer.receiveShadow = true
  scene.add(outer)
}

// ─────────────────────────────────────────────────────────────────────────────
// Site structures
// ─────────────────────────────────────────────────────────────────────────────
function warehouse(bd, r) {
  const { x, y, w, d, h } = bd
  const p = W(x, y)
  const grp = new THREE.Group(); grp.position.set(p.x, 0, p.z)
  const g = new THREE.BoxGeometry(w, h, d)
  const walls = new THREE.Mesh(g, mats.wall); walls.position.y = h / 2; walls.castShadow = walls.receiveShadow = true; grp.add(walls)
  walls.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), mats.edge))
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, 0.9, d + 0.8), mats.roof); roof.position.y = h + 0.45; roof.castShadow = roof.receiveShadow = true; grp.add(roof)
  for (let i = 0; i < 2 + Math.floor(r() * 3); i++) {
    const u = new THREE.Mesh(new THREE.BoxGeometry(4 + r() * 6, 2 + r() * 1.5, 3 + r() * 4), mats.unit)
    u.position.set((r() - 0.5) * w * 0.6, h + 1.8, (r() - 0.5) * d * 0.6); u.castShadow = true; grp.add(u)
  }
  const floors = h > 20 ? 2 : 1
  for (const side of [1, -1]) for (let f = 0; f < floors; f++) {
    const segs = 6, segW = (w * 0.84) / segs
    for (let i = 0; i < segs; i++) {
      const lit = bd.lit && r() < 0.55
      const win = new THREE.Mesh(new THREE.BoxGeometry(segW * 0.86, 1.1, 0.2), lit ? mats.winLit : mats.winDark)
      win.position.set(-w * 0.42 + segW * (i + 0.5), h * (floors === 2 ? (f ? 0.72 : 0.38) : 0.58), side * (d / 2 + 0.1))
      grp.add(win)
    }
  }
  for (let i = 0; i < 2; i++) { const dr = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5.5, 6), mats.door); dr.position.set(w / 2 + 0.1, 2.75, -d / 4 + i * (d / 2) - 3 * (i ? 1 : -1) * 0.3); grp.add(dr) }
  scene.add(grp)
}

function pipeRack(x0, y0, x1, y1) {
  const a = W(x0, y0), b = W(x1, y1)
  const dir = b.clone().sub(a), len = dir.length(); dir.normalize()
  const side = new V(-dir.z, 0, dir.x)
  const geos = []
  for (let t = 0; t <= len; t += 12) {
    const c = a.clone().addScaledVector(dir, t)
    for (const sgn of [-1.5, 1.5]) geos.push(beam(c.clone().addScaledVector(side, sgn), c.clone().addScaledVector(side, sgn).add(new V(0, 7, 0)), 0.35))
    geos.push(beam(c.clone().addScaledVector(side, -1.5).add(new V(0, 7, 0)), c.clone().addScaledVector(side, 1.5).add(new V(0, 7, 0)), 0.3))
  }
  for (const off of [-1, 0, 1]) {
    const g = new THREE.CylinderGeometry(0.35, 0.35, len, 10)
    g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5).addScaledVector(side, off * 0.9).add(new V(0, 7.6, 0)), new THREE.Quaternion().setFromUnitVectors(new V(0, 1, 0), dir), new V(1, 1, 1)))
    geos.push(g)
  }
  const m = new THREE.Mesh(mergeGeometries(geos.map((g) => g.toNonIndexed())), mats.steel); m.castShadow = true; scene.add(m)
}

function tank(x, y, r, h, mat = mats.tank) {
  const p = W(x, y)
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 40), mat); body.position.set(p.x, h / 2, p.z); body.castShadow = body.receiveShadow = true; scene.add(body)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat); dome.scale.y = 0.2; dome.position.set(p.x, h, p.z); dome.castShadow = true; scene.add(dome)
  for (const k of [0.33, 0.66]) { const band = new THREE.Mesh(new THREE.TorusGeometry(r + 0.05, 0.12, 6, 48), mats.steel); band.rotation.x = Math.PI / 2; band.position.set(p.x, h * k, p.z); scene.add(band) }
}

function flareStack(a) {
  const p = W(a.x, a.y), H = 68
  const cv = document.createElement('canvas'); cv.width = 8; cv.height = 256
  const g = cv.getContext('2d'); g.fillStyle = '#8b8f97'; g.fillRect(0, 0, 8, 256)
  for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? '#d9dadc' : '#b5352d'; g.fillRect(0, i * 14, 8, 14) }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.2, H, 24), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.3 }))
  stack.position.set(p.x, H / 2, p.z); stack.castShadow = true; scene.add(stack)
  const plat = new THREE.Mesh(new THREE.BoxGeometry(9, 1.6, 9), mats.wall); plat.position.set(p.x, 0.8, p.z); plat.castShadow = true; scene.add(plat)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.15, 6, 24), mats.steel); ring.rotation.x = Math.PI / 2; ring.position.set(p.x, H * 0.62, p.z); scene.add(ring)
  for (let i = 0; i < 3; i++) { // guy wires
    const ang = (i / 3) * Math.PI * 2 + 0.4
    const top = new V(p.x, H * 0.72, p.z), anc = new V(p.x + Math.cos(ang) * 34, 0, p.z + Math.sin(ang) * 34)
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([top, anc]), new THREE.LineBasicMaterial({ color: 0x80848e, transparent: true, opacity: 0.45 })))
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(1.3, 6, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xffa54a, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false }))
  flame.position.set(p.x, H + 3, p.z); scene.add(flame)
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.6, 3.5, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff1c9, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }))
  core.position.set(p.x, H + 1.9, p.z); scene.add(core)
  const fl = new THREE.PointLight(0xff9a3c, 900, 140, 2); fl.position.set(p.x, H + 4, p.z); scene.add(fl)
  aviationLight(new V(p.x + 1.8, H - 2, p.z), 0xff3b30, 0.5, 1.4)
  return { flame, core, light: fl }
}

function coolingTower(a) {
  const p = W(a.x, a.y), H = 48
  const pts = []
  for (let h = 0; h <= H; h += 2) pts.push(new THREE.Vector2(13 * Math.sqrt(1 + ((h - 36) / 22) ** 2), h))
  const shell = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), mats.concrete)
  shell.position.set(p.x, 0, p.z); shell.castShadow = shell.receiveShadow = true; scene.add(shell)
  const rim = new THREE.Mesh(new THREE.TorusGeometry(pts[pts.length - 1].x, 0.5, 8, 64), mats.concrete); rim.rotation.x = Math.PI / 2; rim.position.set(p.x, H, p.z); scene.add(rim)
  // steam plume
  const cv = document.createElement('canvas'); cv.width = cv.height = 64
  const g = cv.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(cv)
  const puffs = []
  for (let i = 0; i < 16; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xc9cfd8, transparent: true, depthWrite: false, opacity: 0 }))
    sp.userData.age = i / 16
    scene.add(sp); puffs.push(sp)
  }
  return { origin: new V(p.x, H, p.z), puffs }
}

function towerCrane(o) {
  const p = W(o.x, o.y)
  const H = o.heightM - 8, a = 1.15, t = 0.24, geos = []
  const C = [[-a, -a], [a, -a], [a, a], [-a, a]]
  for (const [cx, cz] of C) geos.push(beam(new V(p.x + cx, 0, p.z + cz), new V(p.x + cx, H, p.z + cz), 0.32))
  for (let y = 0, k = 0; y < H; y += 3.6, k++) {
    const y2 = Math.min(H, y + 3.6)
    for (let i = 0; i < 4; i++) {
      const [x1, z1] = C[i], [x2, z2] = C[(i + 1) % 4]
      geos.push(beam(new V(p.x + x1, y, p.z + z1), new V(p.x + x2, y, p.z + z2), t))
      geos.push(k % 2 ? beam(new V(p.x + x1, y, p.z + z1), new V(p.x + x2, y2, p.z + z2), t * 0.8) : beam(new V(p.x + x2, y, p.z + z2), new V(p.x + x1, y2, p.z + z1), t * 0.8))
    }
  }
  const L = 62, jy = H
  for (const z of [-0.95, 0.95]) geos.push(beam(new V(p.x + a, jy, p.z + z), new V(p.x + L, jy, p.z + z), 0.26))
  geos.push(beam(new V(p.x + a, jy + 2.3, p.z), new V(p.x + L - 2, jy + 2.3, p.z), 0.26))
  for (let x = a; x < L; x += 3) {
    geos.push(beam(new V(p.x + x, jy, p.z - 0.95), new V(p.x + x, jy, p.z + 0.95), 0.16))
    for (const z of [-0.95, 0.95]) geos.push(beam(new V(p.x + x, jy, p.z + z), new V(p.x + Math.min(L - 2, x + 3), jy + 2.3, p.z), 0.14))
  }
  const CL = 18
  for (const z of [-1.0, 1.0]) geos.push(beam(new V(p.x - a, jy, p.z + z), new V(p.x - CL, jy, p.z + z), 0.3))
  for (let x = a; x < CL; x += 3) geos.push(beam(new V(p.x - x, jy, p.z - 1), new V(p.x - x, jy, p.z + 1), 0.18))
  const apex = new V(p.x, H + 8, p.z)
  for (const [cx, cz] of C) geos.push(beam(new V(p.x + cx, H, p.z + cz), apex, 0.24))
  geos.push(beam(apex, new V(p.x + 42, jy + 2.3, p.z), 0.12))
  geos.push(beam(apex, new V(p.x - CL + 1, jy, p.z), 0.12))
  const crane = new THREE.Mesh(mergeGeometries(geos.map((g) => g.toNonIndexed())), mats.crane)
  crane.castShadow = true; scene.add(crane)
  for (let i = 0; i < 3; i++) { const cw = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.8, 2.6), mats.concrete); cw.position.set(p.x - CL + 2.2 + i * 2.7, jy - 1.4, p.z); cw.castShadow = true; scene.add(cw) }
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.6), mats.crane); cab.position.set(p.x + 2.6, H - 2.4, p.z + 1.6); scene.add(cab)
  const cabWin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 2), mats.winLit); cabWin.position.set(p.x + 3.95, H - 2.2, p.z + 1.6); scene.add(cabWin)
  const trolley = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.8, 2.4), mats.steel); trolley.position.set(p.x + 38, jy - 0.4, p.z); scene.add(trolley)
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V(p.x + 38, jy - 0.8, p.z), new V(p.x + 38, jy - 44, p.z)]), new THREE.LineBasicMaterial({ color: 0x9aa0aa })))
  const hook = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.6, 1.2), mats.crane); hook.position.set(p.x + 38, jy - 45, p.z); scene.add(hook)
  const load = new THREE.Mesh(new THREE.BoxGeometry(9, 0.8, 1.4), mats.steel); load.position.set(p.x + 38, jy - 48, p.z); load.castShadow = true; scene.add(load)
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 7), mats.concrete); base.position.set(p.x, 0.6, p.z); scene.add(base)
  aviationLight(apex.clone().add(new V(0, 0.8, 0)), 0xff3b30, 0.7, 1.0)
  aviationLight(new V(p.x + L, jy + 0.6, p.z), 0xff3b30, 0.6, 1.0)
}

function noFlyZone(o) {
  const p = W(o.x, o.y), H = 140
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { color: { value: new THREE.Color(0xef4a40) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 color; varying vec2 vUv; void main(){ float a = 0.075 * pow(1.0 - vUv.y, 1.8) + 0.035 * step(0.985, vUv.y); float stripes = step(0.5, fract(vUv.x * 72.0)) * 0.012 * (1.0 - vUv.y); gl_FragColor = vec4(color, a + stripes); }',
  })
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r, H, 96, 1, true), mat)
  wall.position.set(p.x, H / 2, p.z); scene.add(wall)
  const ringG = new THREE.Mesh(new THREE.RingGeometry(o.r - 0.9, o.r, 128), new THREE.MeshBasicMaterial({ color: 0xef5f57, transparent: true, opacity: 0.7, side: THREE.DoubleSide }))
  ringG.rotation.x = -Math.PI / 2; ringG.position.set(p.x, 0.3, p.z); scene.add(ringG)
  const circ = []
  for (let i = 0; i <= 128; i++) { const a2 = (i / 128) * Math.PI * 2; circ.push(new V(p.x + Math.cos(a2) * o.r, H, p.z + Math.sin(a2) * o.r)) }
  const top = new THREE.Line(new THREE.BufferGeometry().setFromPoints(circ), new THREE.LineDashedMaterial({ color: 0xef5f57, dashSize: 6, gapSize: 5, transparent: true, opacity: 0.45 }))
  top.computeLineDistances(); scene.add(top)
  const t = tag(`<b>NFZ · ${o.label}</b><span>Tower crane, ${o.heightM} m AGL</span>`, 'nfz'); t.position.set(p.x - o.r * 0.72, 26, p.z + o.r * 0.72); scene.add(t)
}

function geofence(mission) {
  const c = W(500, 500), R = mission.geofenceR, pts = []
  for (let i = 0; i <= 256; i++) { const a = (i / 256) * Math.PI * 2; pts.push(new V(c.x + Math.cos(a) * R, 0.4, c.z + Math.sin(a) * R)) }
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0x8e95a6, dashSize: 10, gapSize: 8, transparent: true, opacity: 0.32 }))
  l.computeLineDistances(); scene.add(l)
  const t = tag(`<b>Geofence</b><span>R ${R} m</span>`, 'dim'); t.position.set(c.x + R * 0.71, 2, c.z + R * 0.71); scene.add(t)
}

function helipad(mission) {
  const p = W(mission.base.x, mission.base.y)
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; const l = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), new THREE.MeshBasicMaterial({ color: 0x46e07f })); l.position.set(p.x + Math.cos(a) * 15.5, 0.4, p.z + Math.sin(a) * 15.5); scene.add(l) }
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 8), mats.steel); pole.position.set(p.x + 19, 3, p.z - 19); scene.add(pole)
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.2, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0xe0703a, roughness: 0.8, side: THREE.DoubleSide }))
  sock.rotation.z = -Math.PI / 2 + 0.25; sock.rotation.y = Math.atan2(0.4, 0.6); sock.position.set(p.x + 20.4, 5.6, p.z - 19.6); scene.add(sock)
  const t = tag(`<b>${mission.home}</b><span>Home · launch and recovery</span>`); t.position.set(p.x, 9, p.z + 6); scene.add(t)
}

function trees() {
  const r = rng(11), N = 520
  const geo = new THREE.ConeGeometry(1, 1, 7); geo.translate(0, 0.5, 0)
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 1 }), N)
  mesh.castShadow = true; mesh.receiveShadow = true
  const m = new THREE.Matrix4(), col = new THREE.Color()
  let n = 0, tries = 0
  while (n < N && tries < 20000) {
    tries++
    const x = -230 + r() * 1460, y = -230 + r() * 1460
    const inside = x > FENCE.x0 - 18 && x < FENCE.x1 + 18 && y > FENCE.y0 - 18 && y < FENCE.y1 + 18
    if (inside) continue
    if (Math.abs(y - 470) < 16 && x < 240) continue
    const cluster = 0.5 + 0.5 * Math.sin(x * 0.011) * Math.cos(y * 0.013) + 0.3 * Math.sin((x + y) * 0.021)
    if (r() > cluster) continue
    const s = 3 + r() * 3.5, h = 9 + r() * 9
    const p = W(x, y)
    m.compose(p, new THREE.Quaternion(), new V(s, h, s))
    mesh.setMatrixAt(n, m)
    col.setHSL(0.36 + r() * 0.06, 0.18 + r() * 0.1, 0.11 + r() * 0.05)
    mesh.setColorAt(n, col)
    n++
  }
  mesh.count = n
  scene.add(mesh)
}

function streetLights() {
  const ring = ROADS[0], pts = []
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1], len = Math.hypot(x2 - x1, y2 - y1)
    for (let t = 20; t < len; t += 55) pts.push([x1 + ((x2 - x1) * t) / len, y1 + ((y2 - y1) * t) / len, (y2 - y1) / len, -(x2 - x1) / len])
  }
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 9, 6); poleGeo.translate(0, 4.5, 0)
  const poles = new THREE.InstancedMesh(poleGeo, mats.steel, pts.length)
  const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }), pts.length)
  const m = new THREE.Matrix4()
  pts.forEach(([x, y, nx, ny], i) => {
    const p = W(x + nx * 8, y + ny * 8)
    m.makeTranslation(p.x, 0, p.z); poles.setMatrixAt(i, m)
    m.makeTranslation(p.x, 9.1, p.z); lamps.setMatrixAt(i, m)
  })
  scene.add(poles, lamps)
}

// ─────────────────────────────────────────────────────────────────────────────
// Waypoints, inspection, route
// ─────────────────────────────────────────────────────────────────────────────
let wpViz = [], assetTargets = [], flare = null, tower = null
function buildMission(m) {
  buildGround(m)
  BUILDINGS.forEach((b) => warehouse(b, rng(b.x * 7 + b.y)))
  pipeRack(426, 332, 585, 322)
  pipeRack(320, 528, 322, 610)
  tank(250, 255, 9, 14); tank(274, 262, 9, 14); tank(262, 286, 9, 14)
  trees(); streetLights(); geofence(m); helipad(m)
  for (const o of m.obstacles) { towerCrane(o); noFlyZone(o) }
  for (const wp of m.waypoints) {
    const a = wp.asset
    if (a.kind === 'stack') { flare = flareStack(a); assetTargets.push(W(a.x, a.y, 48)) }
    if (a.kind === 'tanks') { for (const [dx, dy] of [[-15, -15], [15, -15], [-15, 15], [15, 15]]) tank(a.x + dx, a.y + dy, 12, 18); assetTargets.push(W(a.x, a.y, 12)) }
    if (a.kind === 'cooling') { tower = coolingTower(a); assetTargets.push(W(a.x, a.y, 34)) }
  }
  // planned route at cruise altitude
  const route = [W(m.base.x, m.base.y, m.cruiseAlt), ...m.waypoints.map((w) => W(w.x, w.y, w.alt)), W(m.base.x, m.base.y, m.cruiseAlt)]
  const rl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(route), new THREE.LineDashedMaterial({ color: 0x8a90a0, dashSize: 7, gapSize: 6, transparent: true, opacity: 0.38 }))
  rl.computeLineDistances(); scene.add(rl)
  wpViz = m.waypoints.map((w) => {
    const p = W(w.x, w.y, w.alt)
    const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([W(w.x, w.y, 0), p]), new THREE.LineDashedMaterial({ color: 0xc9cdd6, dashSize: 2, gapSize: 2, transparent: true, opacity: 0.35 }))
    stem.computeLineDistances(); scene.add(stem)
    const mat = new THREE.MeshBasicMaterial({ color: 0xc9cdd6 })
    const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(1.8), mat); diamond.position.copy(p); scene.add(diamond)
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xc9cdd6, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
    const ring = new THREE.Mesh(new THREE.RingGeometry(7.6, 8, 64), ringMat); ring.rotation.x = -Math.PI / 2; ring.position.copy(p); scene.add(ring)
    const t = tag(`<b>${w.id}</b><span>${w.asset.id} · ${w.asset.name}</span>`); t.position.set(p.x, p.y + 12, p.z); scene.add(t)
    return { mat, ringMat, diamond, ring, el: t.element }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Aircraft
// ─────────────────────────────────────────────────────────────────────────────
function makeDrone(ghost = false) {
  const g = new THREE.Group()
  const T = ghost ? { transparent: true, opacity: 0.32, depthWrite: false } : {}
  const shell = new THREE.MeshStandardMaterial({ color: ghost ? 0xef5f57 : 0xd9dce2, roughness: 0.35, metalness: 0.2, ...T })
  const carbon = new THREE.MeshStandardMaterial({ color: ghost ? 0xef5f57 : 0x1d1f23, roughness: 0.55, metalness: 0.4, ...T })
  const metal = new THREE.MeshStandardMaterial({ color: ghost ? 0xef5f57 : 0x9ca1aa, roughness: 0.3, metalness: 0.85, ...T })
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = !ghost; g.add(m); return m }
  add(new THREE.BoxGeometry(1.25, 0.42, 1.9), carbon, 0, 0, 0)
  add(new THREE.CapsuleGeometry(0.5, 0.9, 4, 12), shell, 0, 0.3, 0, Math.PI / 2, 0, 0).scale.set(1, 1, 0.55)
  const rotors = []
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const end = new V(sx * 1.55, 0.05, sz * 1.55)
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, end.length(), 8), carbon)
    arm.position.copy(end.clone().multiplyScalar(0.5)); arm.quaternion.setFromUnitVectors(new V(0, 1, 0), end.clone().normalize()); arm.castShadow = !ghost; g.add(arm)
    add(new THREE.CylinderGeometry(0.19, 0.21, 0.3, 16), metal, end.x, 0.18, end.z)
    const rotor = new THREE.Group(); rotor.position.set(end.x, 0.37, end.z)
    for (const ry of [0, Math.PI]) { const b = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.02, 0.13), carbon); b.position.x = 0.5; b.rotation.set(0.12, 0, 0); const holder = new THREE.Group(); holder.rotation.y = ry; holder.add(b); rotor.add(holder) }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.08, 40), new THREE.MeshBasicMaterial({ color: ghost ? 0xef5f57 : 0xdfe2e8, transparent: true, opacity: ghost ? 0.08 : 0.06, side: THREE.DoubleSide, depthWrite: false }))
    disc.rotation.x = -Math.PI / 2; rotor.add(disc)
    g.add(rotor); rotors.push(rotor)
  }
  for (const sx of [-0.55, 0.55]) { // landing gear
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 6), carbon, sx, -0.45, -0.45, 0, 0, 0)
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 6), carbon, sx, -0.45, 0.45, 0, 0, 0)
    add(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6), carbon, sx, -0.72, 0, Math.PI / 2, 0, 0)
  }
  add(new THREE.BoxGeometry(0.42, 0.34, 0.38), carbon, 0, -0.38, -0.82) // gimbal
  add(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 16), metal, 0, -0.38, -1.03, Math.PI / 2, 0, 0)
  let strobe = null
  if (!ghost) {
    const nav = (c, x) => { const l = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: c })); l.position.set(x, 0.05, -1.62); g.add(l) }
    nav(0x2bff6e, 1.55); nav(0xff2b2b, -1.55)
    strobe = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff })); strobe.position.set(0, 0.1, 0.98); g.add(strobe)
  }
  g.scale.setScalar(DRONE_SCALE)
  g.rotation.order = 'YXZ'
  return { group: g, rotors, strobe }
}

const drone = makeDrone()
const ghost = makeDrone(true)
ghost.group.visible = false
scene.add(drone.group, ghost.group)
const ghostTag = tag('<b>GNSS position</b><span>Δ 0 m</span>', 'ghost'); ghostTag.position.set(0, 4, 0); ghost.group.add(ghostTag)

const gapLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V(), new V()]), new THREE.LineDashedMaterial({ color: 0xef5f57, dashSize: 2.5, gapSize: 2 }))
gapLine.visible = false; scene.add(gapLine)
const dropLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V(), new V()]), new THREE.LineBasicMaterial({ color: 0x8a90a0, transparent: true, opacity: 0.5 }))
scene.add(dropLine)
const groundMark = new THREE.Mesh(new THREE.RingGeometry(2.4, 3, 32), new THREE.MeshBasicMaterial({ color: 0xe9ebf0, transparent: true, opacity: 0.45, side: THREE.DoubleSide }))
groundMark.rotation.x = -Math.PI / 2; scene.add(groundMark)

// camera frustum while inspecting
const frustum = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4, 1, true), new THREE.MeshBasicMaterial({ color: 0xe9ebf0, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }))
frustum.geometry.rotateY(Math.PI / 4); frustum.geometry.translate(0, -0.5, 0); frustum.geometry.rotateX(-Math.PI / 2)
frustum.visible = false; scene.add(frustum)
const frustumEdges = new THREE.LineSegments(new THREE.EdgesGeometry(frustum.geometry), new THREE.LineBasicMaterial({ color: 0xe9ebf0, transparent: true, opacity: 0.35 }))
frustum.add(frustumEdges)

// flown trail
const TRAIL_MAX = 5000, trailArr = new Float32Array(TRAIL_MAX * 3), trailGeo = new THREE.BufferGeometry()
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailArr, 3)); trailGeo.setDrawRange(0, 0)
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xe9ebf0, transparent: true, opacity: 0.55 }))
trail.frustumCulled = false; scene.add(trail)
let trailN = 0
function pushTrail(v) {
  if (trailN > 0) { const i = (trailN - 1) * 3; if (Math.hypot(trailArr[i] - v.x, trailArr[i + 1] - v.y, trailArr[i + 2] - v.z) < 2.5) return }
  if (trailN >= TRAIL_MAX) return
  trailArr.set([v.x, v.y, v.z], trailN * 3); trailN++
  trailGeo.setDrawRange(0, trailN); trailGeo.attributes.position.needsUpdate = true
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD
// ─────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const MODE = { ground: 'Standby', takeoff: 'Takeoff', enroute: 'Auto · Mission', inspect: 'Auto · Inspect', hold: 'Loiter', rtb: 'RTL', landing: 'Land', landed: 'Landed', aborted: 'Aborted' }
const pad3 = (n) => String(Math.round(((n % 360) + 360) % 360)).padStart(3, '0')
const met = (t) => { const s = Math.max(0, Math.floor(t)); return `T+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
function humanTool(tool, args, asset) {
  switch (tool) {
    case 'continue': return 'Continue'
    case 'set_heading': return `Set heading ${pad3(args?.heading ?? 0)}°`
    case 'set_altitude': return `Set altitude ${Math.round(args?.altitude ?? 0)} m`
    case 'hold': return 'Loiter'
    case 'return_to_base': return 'Return to launch'
    case 'land': return 'Land'
    case 'takeoff': return 'Takeoff'
    case 'inspect_asset': return `Inspection ${asset ?? ''}`.trim()
    case 'reject_gnss': return 'Nav source → VIO'
    default: return tool ?? ''
  }
}

// heading tape
const PPD = 4 // px per degree
{
  const strip = $('tape'); let html = ''
  for (let d = -360; d <= 720; d += 5) {
    const x = (d + 360) * PPD, n = ((d % 360) + 360) % 360
    const cls = n % 30 === 0 ? 'maj' : n % 10 === 0 ? 'mid' : 'min'
    html += `<div class="tick ${cls}" style="left:${x}px"></div>`
    if (n % 30 === 0) { const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[n] ?? String(n).padStart(3, '0'); html += `<div class="tlabel ${lbl.length === 1 ? 'card' : ''}" style="left:${x}px">${lbl}</div>` }
  }
  strip.innerHTML = html
}
function setTape(h) { $('tape').style.transform = `translateX(${220 - (h + 360) * PPD}px)`; $('hdg').textContent = pad3(h) + '°' }

let stepsBuilt = false
function buildSteps(m) {
  const items = [{ n: 'Launch', l: 'Takeoff' }, ...m.waypoints.map((w) => ({ n: w.id, l: `${w.asset.id} ${w.asset.name}` })), { n: 'Return', l: 'RTL' }, { n: 'Recovery', l: `Land ${m.home}` }]
  $('steps').innerHTML = items.map((it, i) => `<div class="step" data-i="${i}"><div class="n">${it.n}</div><div class="l">${it.l}</div><div class="bar2"></div></div>`).join('')
  stepsBuilt = true
}
function updateSteps(s, m) {
  const n = m.waypoints.length, els = [...document.querySelectorAll('.step')]
  const st = els.map(() => 'pending')
  const ph = s.phase
  if (ph === 'takeoff') st[0] = 'current'
  if (['enroute', 'inspect', 'hold', 'rtb', 'landing', 'landed', 'aborted'].includes(ph)) st[0] = 'done'
  for (let i = 0; i < n; i++) {
    if (i < s.wpReached) st[i + 1] = 'done'
    else if (['rtb', 'landing', 'landed', 'aborted'].includes(ph)) st[i + 1] = 'skipped'
    else if (i === s.targetWp && ph !== 'takeoff' && ph !== 'ground') st[i + 1] = 'current'
  }
  if (ph === 'rtb') st[n + 1] = 'current'
  if (ph === 'landing') { st[n + 1] = 'done'; st[n + 2] = 'current' }
  if (ph === 'landed') { st[n + 1] = 'done'; st[n + 2] = 'done' }
  els.forEach((el, i) => {
    const fault = s.faultDetected && (i === n + 1) && (ph === 'rtb' || ph === 'landing' || ph === 'landed')
    el.className = 'step ' + st[i] + (fault ? ' fault' : '')
  })
}

let lastStreamKey = ''
function hud() {
  const m = S.mission, s = S.snap, d = S.lastDecision
  $('msnId').textContent = m.id
  $('msnName').textContent = m.name
  $('met').textContent = met(s.t)
  const mode = $('mode'); mode.textContent = MODE[s.phase] ?? s.phase
  mode.className = 'chip mode' + (s.phase === 'rtb' || s.phase === 'aborted' ? ' bad' : s.phase === 'landed' ? ' ok' : '')
  $('simChip').textContent = `ArduPilot SITL · ×${S.timeScale}`
  const live = S.voight.mode === 'live'
  $('stream').innerHTML = `<span class="dot ${live ? 'live' : 'off'}"></span><span>${live ? 'Streaming to Voight' : 'Voight offline · dry run'}</span><span class="mono" style="color:var(--fg3)">${S.voight.sent}</span>`
  const up = s.link.connected
  $('link').innerHTML = `<span class="dot ${up ? 'live' : 'off'}"></span><span>${up ? 'MAVLink 2' : 'MAVLink · connecting'}</span><span class="mono" style="color:var(--fg3)">${up ? s.link.rate + ' msg/s' : ''}</span>`

  $('vehName').textContent = S.autopilot?.firmware ? `${m.vehicle} ${S.autopilot.firmware.replace(/^ArduCopter\s*/, '')}` : m.vehicle
  $('vehSub').textContent = s.phase === 'inspect' && s.inspect ? `On station · ${s.inspect.asset}` : s.armed ? s.apMode : (MODE[s.phase] ?? '').toUpperCase()
  $('ro-alt').innerHTML = `${s.alt.toFixed(1)}<span class="u">m</span>`
  $('ro-gs').innerHTML = `${s.speed.toFixed(1)}<span class="u">m/s</span>`
  $('ro-vs').innerHTML = `${s.vs >= 0 ? '+' : ''}${s.vs.toFixed(1)}<span class="u">m/s</span>`
  $('ro-hdg').innerHTML = `${pad3(s.heading)}<span class="u">°</span>`
  $('ro-home').innerHTML = `${s.distToBase}<span class="u">m</span>`
  const next = s.phase === 'rtb' || s.phase === 'landing' || s.phase === 'landed' ? 'Home' : m.waypoints[s.targetWp]?.id ?? 'Home'
  $('ro-next').innerHTML = `${next}<span class="u">${s.phase === 'landed' ? '' : s.distToTarget + ' m'}</span>`
  $('batFill').style.width = s.battery + '%'
  $('batFill').style.background = s.battery < 25 ? 'var(--bad)' : s.battery < 45 ? 'var(--warn)' : 'var(--ok)'
  $('batTxt').textContent = `${Math.round(s.battery)}% · ${s.voltage.toFixed(1)} V`

  $('gnssFix').textContent = `3D fix · ${s.sats} sats · HDOP ${s.hdop.toFixed(2)}`
  $('gnssPos').textContent = `E ${s.gpsPos.x} · N ${s.gpsPos.y}`
  $('insPos').textContent = `E ${s.inertialPos.x} · N ${s.inertialPos.y}`
  $('navSrc').textContent = s.navSource === 'VIO' ? 'VIO · EKF3 source set 2' : `GNSS · EKF3${s.ekfPosRatio > 1 ? ' · rejecting GNSS' : ''}`
  $('navSrc').style.color = s.navSource === 'VIO' ? 'var(--warn)' : s.ekfPosRatio > 1 ? 'var(--bad)' : ''
  const dv = s.divergence
  $('divVal').innerHTML = `${dv.toFixed(1)}<span class="u">m</span>`
  $('divVal').style.color = dv > 20 ? 'var(--bad)' : dv > 8 ? 'var(--warn)' : 'var(--fg)'
  $('divFill').style.width = Math.min(100, (dv / 40) * 100) + '%'
  $('divFill').style.background = dv > 20 ? 'var(--bad)' : dv > 8 ? 'var(--warn)' : 'var(--ok)'
  const ns = $('navState')
  if (s.faultDetected || dv > 20) { ns.textContent = s.navSource === 'VIO' ? 'GNSS rejected · VIO' : 'GNSS rejected'; ns.className = 'chip bad' }
  else if (dv > 8) { ns.textContent = 'Degraded'; ns.className = 'chip'; ns.style.color = 'var(--warn)' }
  else { ns.textContent = 'Nominal'; ns.className = 'chip ok'; ns.style.color = '' }
  ns.style.padding = '4px 7px'

  $('agentModel').textContent = S.model
  if (d) {
    $('agentAct').textContent = humanTool(d.cmd.tool, { heading: d.cmd.heading, altitude: d.cmd.altitude })
    const src = $('agentSrc')
    if (d.overridden) { src.textContent = 'Safety override'; src.className = 'src ovr' }
    else if (d.source === 'llm') { src.textContent = `Model · ${(d.durationMs / 1000).toFixed(1)} s`; src.className = 'src' }
    else { src.textContent = 'Rule-based'; src.className = 'src' }
    $('agentWhy').textContent = d.reasoning
  }
  $('agentSeq').textContent = `Decision ${S.decisionSeq}`
  $('agentCad').textContent = `cadence ${S.decisionEvery} s`

  $('traceId').textContent = `trace ${S.traceId.slice(0, 8)}`
  const rows = S.stream.slice().reverse().slice(0, 11)
  const key = rows.map((r) => r.t + r.type + r.tool).join('|')
  if (key !== lastStreamKey) {
    const fresh = lastStreamKey === '' ? 0 : 1
    lastStreamKey = key
    $('ev').innerHTML = rows.map((r, i) => {
      const ok = r.outcome !== 'failed'
      const color = r.status === 'failed' ? 'var(--bad)' : r.status === 'dry' ? 'var(--fg4)' : ok ? 'var(--ok)' : 'var(--bad)'
      const detail = r.type === 'error' ? (r.summary ?? 'Error') : humanTool(r.tool, r.args, r.asset)
      const right = r.type === 'decision' && r.ms != null && r.tool !== 'land' ? `${(r.ms / 1000).toFixed(1)} s` : ''
      return `<div class="er ${i < fresh ? 'fresh' : ''}"><span class="tt">${met(r.t)}</span><span class="ty ${r.type}">${r.type.toUpperCase()}</span><span class="d">${esc(detail)}</span><span class="s">${right}<i style="background:${color}"></i></span></div>`
    }).join('')
  }

  if (!stepsBuilt) buildSteps(m)
  updateSteps(s, m)

  const cas = $('cas')
  if (s.phase === 'ground' && s.preflight) { cas.className = 'cas info'; cas.innerHTML = `Pre-flight <span class="sub">${esc(s.preflight)}</span>` }
  else if (s.faultDetected && s.phase !== 'landed') { cas.className = 'cas warn'; cas.innerHTML = `GNSS integrity fault <span class="sub">Δ ${dv.toFixed(0)} m vs EKF · GNSS rejected · ${s.navSource === 'VIO' ? 'VIO navigation · ' : ''}RTL</span>` }
  else if (s.phase === 'inspect' && s.inspect) { cas.className = 'cas info'; cas.innerHTML = `Inspecting ${s.inspect.asset} <span class="sub">${s.inspect.name} · ${s.inspect.remaining.toFixed(1)} s</span>` }
  else if (s.phase === 'landed') { cas.className = 'cas info'; cas.innerHTML = `${S.snap.faultDetected ? 'Mission aborted' : 'Mission complete'} <span class="sub">${s.wpReached}/${m.waypoints.length} assets inspected · landed at ${m.home}</span>` }
  else { cas.className = 'cas' }
}

// ─────────────────────────────────────────────────────────────────────────────
// State stream
// ─────────────────────────────────────────────────────────────────────────────
let S = null, built = false, traceId = null, vignetted = false
const target = { pos: W(120, 120), ghost: W(120, 120), heading: 45, speed: 0, alt: 0, divergence: 0 }
const smooth = { pos: target.pos.clone(), ghost: target.ghost.clone(), heading: 45, roll: 0, pitch: 0 }

// Live: state from the bridge over SSE. Replay (?replay): states and frame steps are fed by window.__replay.
const REPLAY = new URLSearchParams(location.search).has('replay')
function onState(data) {
  S = data
  const m = S.mission, s = S.snap
  if (!built) { built = true; buildMission(m); $('boot').remove() }
  if (S.traceId !== traceId) { traceId = S.traceId; trailN = 0; trailGeo.setDrawRange(0, 0); vignetted = false; smooth.pos.copy(W(s.pos.x, s.pos.y, s.alt)); smooth.heading = s.heading; lastStreamKey = '' }
  target.pos = W(s.pos.x, s.pos.y, s.alt)
  target.ghost = W(s.gpsPos.x, s.gpsPos.y, s.alt)
  target.heading = s.heading; target.speed = s.speed; target.alt = s.alt; target.divergence = s.divergence
  wpViz.forEach((w, i) => {
    const done = i < s.wpReached, active = i === s.targetWp && (s.phase === 'enroute' || s.phase === 'inspect')
    const c = done ? 0x5fcf8f : active ? 0xd6dae2 : 0x8d939e
    w.mat.color.setHex(c); w.ringMat.color.setHex(c)
    w.el.className = 'tag' + (done ? ' done' : active ? ' active' : '')
  })
  if (s.faultDetected && !vignetted) { vignetted = true; $('vignette').classList.add('on'); setTimeout(() => $('vignette').classList.remove('on'), 2600) }
  hud()
}
if (!REPLAY) new EventSource('/events').onmessage = (e) => onState(JSON.parse(e.data))

// ─────────────────────────────────────────────────────────────────────────────
// Cameras
// ─────────────────────────────────────────────────────────────────────────────
let camMode = 'auto'
const camPos = camera.position.clone(), look = new V(0, 30, 0)
let orbitA = 2.3, inspectA = 0
document.querySelectorAll('.cams button').forEach((b) => b.addEventListener('click', () => setCam(b.dataset.cam)))
addEventListener('keydown', (e) => {
  const k = { 1: 'auto', 2: 'chase', 3: 'orbit', 4: 'top' }[e.key]
  if (k) setCam(k)
  if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('clean')
})
function setCam(m) { camMode = m; document.querySelectorAll('.cams button').forEach((b) => b.classList.toggle('on', b.dataset.cam === m)) }
const fwd = (deg) => { const r = (deg * Math.PI) / 180; return new V(Math.sin(r), 0, -Math.cos(r)) }

function updateCamera(dt) {
  const s = S?.snap
  const mode = camMode !== 'auto' ? camMode : !s ? 'orbit' : S.finished ? 'orbit' : s.faultDetected ? 'wide' : s.phase === 'inspect' ? 'inspect' : 'chase'
  const k = (r) => 1 - Math.exp(-dt * r)
  const f = fwd(smooth.heading), right = new V(-f.z, 0, f.x)
  if (mode === 'chase') {
    const desired = smooth.pos.clone().addScaledVector(f, -40).addScaledVector(right, 13).add(new V(0, 14, 0))
    desired.y = Math.max(desired.y, 6)
    camPos.lerp(desired, k(1.9)); look.lerp(smooth.pos.clone().addScaledVector(f, 26).add(new V(0, -5, 0)), k(3))
  } else if (mode === 'inspect') {
    const asset = assetTargets[s.targetWp] ?? smooth.pos
    inspectA += dt * 0.12
    const toA = asset.clone().sub(smooth.pos); toA.y = 0; const dirA = toA.clone().normalize()
    const side = new V(-dirA.z, 0, dirA.x).applyAxisAngle(new V(0, 1, 0), Math.sin(inspectA) * 0.5)
    const desired = smooth.pos.clone().addScaledVector(side, 62).addScaledVector(dirA, -26).add(new V(0, 10, 0))
    camPos.lerp(desired, k(1.2)); look.lerp(smooth.pos.clone().lerp(asset, 0.5), k(2))
  } else if (mode === 'wide') {
    const mid = smooth.pos.clone().lerp(smooth.ghost, 0.5), spread = Math.min(260, smooth.pos.distanceTo(smooth.ghost))
    const desired = smooth.pos.clone().addScaledVector(f, -(95 + spread * 0.8)).addScaledVector(right, 40).add(new V(0, 62 + spread * 0.55, 0))
    camPos.lerp(desired, k(1.3)); look.lerp(mid, k(2.2))
  } else if (mode === 'orbit') {
    orbitA += dt * 0.06
    camPos.lerp(new V(Math.cos(orbitA) * 980, 470, Math.sin(orbitA) * 980), k(1.1)); look.lerp(new V(0, 20, 0), k(1.8))
  } else {
    camPos.lerp(new V(0, 1350, 1), k(1.4)); look.lerp(new V(0, 0, 0), k(2))
  }
  camera.position.copy(camPos); camera.lookAt(look)
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame loop
// ─────────────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock()
const _q = new THREE.Quaternion()
function render(dt, t) {
  const k = 1 - Math.exp(-dt * 6)
  smooth.pos.lerp(target.pos, k); smooth.ghost.lerp(target.ghost, k)
  const dh = ((target.heading - smooth.heading + 540) % 360) - 180
  const turnRate = (dh * k) / Math.max(dt, 1e-3)
  smooth.heading = (smooth.heading + dh * k + 360) % 360
  smooth.pitch += (-0.17 * Math.min(1, target.speed / 12) - smooth.pitch) * (1 - Math.exp(-dt * 2.5))
  smooth.roll += (-THREE.MathUtils.clamp(turnRate * 0.006, -0.42, 0.42) - smooth.roll) * (1 - Math.exp(-dt * 2.5))

  const g = drone.group
  g.position.copy(smooth.pos); g.position.y += 0.85 * DRONE_SCALE
  g.rotation.set(smooth.pitch, (-smooth.heading * Math.PI) / 180, smooth.roll)
  const flying = target.alt > 0.3
  const spin = flying ? 55 : S?.snap?.phase === 'takeoff' ? 40 : 0
  for (const r of drone.rotors) r.rotation.y += spin * dt
  for (const r of ghost.rotors) r.rotation.y += spin * dt
  if (drone.strobe) drone.strobe.visible = flying && (t % 1.1) < 0.08

  const showGhost = target.divergence > 8 // GNSS noise against the EKF is a few metres; show the ghost once it is degraded
  ghost.group.visible = gapLine.visible = showGhost
  if (showGhost) {
    ghost.group.position.set(smooth.ghost.x, g.position.y, smooth.ghost.z); ghost.group.rotation.copy(g.rotation)
    const gp = gapLine.geometry.attributes.position
    gp.setXYZ(0, g.position.x, g.position.y, g.position.z); gp.setXYZ(1, ghost.group.position.x, ghost.group.position.y, ghost.group.position.z)
    gp.needsUpdate = true; gapLine.computeLineDistances()
    ghostTag.element.innerHTML = `<b>GNSS position</b><span>Δ ${target.divergence.toFixed(0)} m from EKF</span>`
  }

  const dp = dropLine.geometry.attributes.position
  dp.setXYZ(0, g.position.x, g.position.y - 1.5, g.position.z); dp.setXYZ(1, g.position.x, 0.3, g.position.z); dp.needsUpdate = true
  groundMark.position.set(g.position.x, 0.35, g.position.z)
  dropLine.visible = groundMark.visible = flying
  if (flying) pushTrail(g.position)

  // inspection frustum: gimbal camera onto the asset
  const insp = S?.snap?.phase === 'inspect' ? assetTargets[S.snap.targetWp] : null
  frustum.visible = !!insp
  if (insp) {
    const from = g.position.clone().add(new V(0, -1.2, 0)), dir = insp.clone().sub(from), len = dir.length()
    frustum.position.copy(from)
    frustum.quaternion.copy(_q.setFromUnitVectors(new V(0, 0, -1), dir.normalize()))
    frustum.scale.set(len * 0.42, len * 0.3, len)
  }

  // ambient animation
  for (const b of blinkers) { const on = ((t + b.phase) % b.period) < 0.45; b.mesh.material.color.copy(b.base).multiplyScalar(on ? 1 : 0.12) }
  if (flare) { const fl = 0.85 + 0.15 * Math.sin(t * 17) * Math.sin(t * 7.3); flare.flame.scale.set(fl, 0.9 + 0.2 * Math.sin(t * 11), fl); flare.core.scale.setScalar(0.9 + 0.1 * Math.sin(t * 23)); flare.light.intensity = 760 + 220 * Math.sin(t * 13) }
  if (tower) for (const p of tower.puffs) {
    p.userData.age = (p.userData.age + dt * 0.045) % 1
    const a = p.userData.age
    p.position.set(tower.origin.x + a * 55, tower.origin.y + 2 + a * 70, tower.origin.z - a * 20)
    p.scale.setScalar(14 + a * 46)
    p.material.opacity = 0.2 * Math.sin(a * Math.PI)
  }
  wpViz.forEach((w) => { w.diamond.rotation.y += dt * 0.8 })

  if (S) setTape(smooth.heading)
  updateCamera(dt)
  composer.render()
  labels.render(scene, camera)
}
function frame() {
  render(Math.min(clock.getDelta(), 0.25), clock.elapsedTime)
  requestAnimationFrame(frame)
}
if (!REPLAY) requestAnimationFrame(frame)

// Replay: render a recorded flight frame by frame (fixed time steps), CSS animations included,
// so it can be turned into a smooth video at any frame rate.
let replayT = 0
const seenAnims = new WeakSet()
window.__replay = {
  state: (data) => onState(data),
  step(dt) {
    replayT += dt
    render(dt, replayT)
    for (const a of document.getAnimations()) {
      a.pause()
      if (!seenAnims.has(a)) { seenAnims.add(a); a.currentTime = 0 } else a.currentTime = (Number(a.currentTime) || 0) + dt * 1000
    }
  },
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight)
  applyViewOffset()
})

window.__sim = { state: () => ({ camMode, phase: S?.snap?.phase, finished: S?.finished, cam: camera.position.toArray().map(Math.round), pos: smooth.pos.toArray().map(Math.round) }) }
