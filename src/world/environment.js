/**
 * 场景环境 —— 全程序化生成（无任何外部素材，全部几何体 + 材质）。
 *
 * 坐标：右手系，Y 轴向上，单位 = 米。跑道中心线 x = 0，沿 Z 轴延伸，
 * 起飞方向 +Z。风格：低多边形 flat shading + 黄昏暖光。
 *
 * 对外接口：
 *   terrainHeight(x, z)                地形高度采样（主循环做撞地判定用）
 *   createEnvironment(scene)            构建场景，返回 { colliders, runway, update, stats }
 */

import * as THREE from '../../vendor/three.module.js';
import { WORLD, PALETTE } from '../core/constants.js';

// ===========================================================================
// 0. 常量 / 工具
// ===========================================================================

const FLAT_X = 1200;   // 机场平台：|x| < FLAT_X 且 |z| < FLAT_Z 时地形严格为 0
const FLAT_Z = 2200;
const HILL_AMP = 180;  // 丘陵起伏幅度
const MTN_AMP = 420;   // 远处低山最高处

// 湖（远景低洼处，航道的���侧）
const LAKE = { x: -5600, z: 7400, r: 1250, y: 0.5 };

// 跑道面网格标高（略高于地形 0，防 z-fighting）
const RW_Y = 0.06;
const RW_LEN = WORLD.runwayLength;
const RW_HW = WORLD.runwayWidth / 2;

// 太阳方向（从场景指向太阳，低角度西偏南）
const SUN_DIR = new THREE.Vector3(-0.86, 0.225, -0.45).normalize();

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 2D 整数哈希 -> [0,1) */
function hash2(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

/** 双线性插值的 value noise -> [0,1] */
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  const t = a + (b - a) * ux;
  return t + ((c + (d - c) * ux) - t) * uz;
}

/** 4 阶 fbm -> [0,1] */
function fbm(x, z) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < 4; i++) {
    s += amp * vnoise(x * f, z * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return s / 0.9375;
}

// ===========================================================================
// 1. 地形高度场（唯一真源，几何体位移也用这个函数）
// ===========================================================================

export function terrainHeight(x, z) {
  const ax = Math.abs(x), az = Math.abs(z);

  // 机场平台：严格平整
  if (ax < FLAT_X && az < FLAT_Z) return 0;

  // 到平台矩形的外部距离
  const dx = Math.max(0, ax - FLAT_X);
  const dz = Math.max(0, az - FLAT_Z);
  const d = Math.sqrt(dx * dx + dz * dz);

  const t = smoothstep(0, 1500, d);
  if (t <= 0) return 0;

  // 丘陵（±HILL_AMP）+ 细节
  const hills = (fbm(x * 0.00028, z * 0.00028) - 0.5) * 2;
  const detail = (fbm(x * 0.0011 + 41.3, z * 0.0011 - 17.9) - 0.5) * 2;
  const hillH = hills * HILL_AMP + detail * 44;

  // 远处抬升为低山（200 ~ MTN_AMP）
  const far = smoothstep(8500, 13500, d);
  const mtnH = 200 + fbm(x * 0.00016 + 7.7, z * 0.00016 - 3.3) * (MTN_AMP - 200);

  let h = (hillH * (1 - far) + mtnH * far) * t;

  // 湖盆：把地形平滑地改造成一个低于水面的碗，远端渐隐回原地形（不会产生断崖）
  const dl = Math.sqrt((x - LAKE.x) * (x - LAKE.x) + (z - LAKE.z) * (z - LAKE.z));
  if (dl < LAKE.r * 3.2) {
    const t1 = smoothstep(LAKE.r * 0.5, LAKE.r, dl);   // 湖心 -> 岸
    const t2 = smoothstep(LAKE.r, LAKE.r * 3.2, dl);   // 岸 -> 原地形
    const w = 1 - t2;
    const target = -5 + t1 * 8;                          // -5 .. +3（+3 高于水面 0.5）
    h = h * (1 - w) + target * w;
  }

  return h;
}

// ===========================================================================
// 2. 轻量几何合并（不依赖 three addons）
// ===========================================================================

/**
 * 合并一组只含 position/normal/uv 的几何体为一个非索引 BufferGeometry。
 * @param {THREE.BufferGeometry[]} geoms
 * @returns {THREE.BufferGeometry}
 */
function mergeGeoms(geoms) {
  const list = [];
  let total = 0;
  for (const g0 of geoms) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    list.push(g);
    total += g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/** 贴地的水平矩形（法线朝上），中心 (x, z)，尺寸 w(X) × l(Z) */
function quad(list, x, z, w, l, y) {
  const g = new THREE.PlaneGeometry(w, l);
  g.rotateX(-Math.PI / 2);      // 局部 +Y -> 世界 -Z，法线 -> +Y
  g.translate(x, y, z);
  list.push(g);
}

/** 长方体，中心 (x, y, z) */
function box(list, x, y, z, sx, sy, sz) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(x, y, z);
  list.push(g);
}

function meshOf(geoms, material, name) {
  const m = new THREE.Mesh(mergeGeoms(geoms), material);
  m.name = name || 'merged';
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  return m;
}

// ===========================================================================
// 3. 跑道号数字贴图（CanvasTexture）
// ===========================================================================

function makeNumberTexture(text) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 384;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 256, 384);
  const col = '#' + PALETTE.markWhite.toString(16).padStart(6, '0');
  g.fillStyle = col;
  g.font = 'bold 210px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 196);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ===========================================================================
// 4. 天空（渐变球 + 太阳圆盘/光晕，零额外 draw call）
// ===========================================================================

function buildSky() {
  const uniforms = {
    uTop: { value: new THREE.Color(PALETTE.skyTop) },
    uHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
    uFog: { value: new THREE.Color(PALETTE.fog) },
    uSun: { value: new THREE.Color(PALETTE.sunColor) },
    uSunDir: { value: SUN_DIR.clone() }
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uTop, uHorizon, uFog, uSun, uSunDir;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }

      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;

        // 天顶 -> 地平线渐变
        float k = pow(clamp(y, 0.0, 1.0), 0.62);
        vec3 col = mix(uHorizon, uTop, k);

        // 地平线附近：太阳一侧更暖
        float sd = max(dot(d, normalize(uSunDir)), 0.0);
        col = mix(col, uSun, pow(sd, 3.0) * 0.35 * (1.0 - k));

        // 地平线以下：过渡到雾色（让地形边缘与天空无缝衔接）
        float below = 1.0 - smoothstep(-0.10, 0.0, y);
        col = mix(col, uFog, below);

        // 高空云带（很淡，仅增加黄昏层次）
        float cl = vnoise(vec2(d.x, d.z) * 6.0 / max(y + 0.35, 0.15));
        cl = smoothstep(0.55, 0.95, cl) * smoothstep(0.02, 0.30, y) * 0.16;
        col = mix(col, mix(uHorizon, uSun, 0.5), cl);

        // 太阳光晕 + 圆盘
        float glow = pow(sd, 220.0) * 0.85 + pow(sd, 14.0) * 0.16 + pow(sd, 3.0) * 0.05;
        float disc = smoothstep(0.99955, 0.99975, sd);
        col += uSun * glow;
        col = mix(col, uSun * 1.9, disc);

        gl_FragColor = vec4(col, 1.0);
      }
    `
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(15000, 40, 24), mat);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  return sky;
}

// ===========================================================================
// 5. 地形（顶点位移 + 顶点色）
// ===========================================================================

function buildTerrain() {
  const SEG = 256;
  const geo = new THREE.PlaneGeometry(WORLD.groundSize, WORLD.groundSize, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const n = pos.count;
  for (let i = 0; i < n; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  // 顶点色：按高度 + 坡度混合 ground / groundAlt / mountain
  const nor = geo.attributes.normal;
  const colors = new Float32Array(n * 3);
  const cGround = new THREE.Color(PALETTE.ground);
  const cAlt = new THREE.Color(PALETTE.groundAlt);
  const cMtn = new THREE.Color(PALETTE.mountain);
  const c = new THREE.Color();
  const tmp = new THREE.Color();

  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const vary = fbm(x * 0.0009, z * 0.0009);

    c.copy(cGround).lerp(cAlt, vary);
    // 中景大块色调变化（农田/林地交错的感觉）
    c.lerp(cAlt, smoothstep(0.62, 0.95, fbm(x * 0.00035 + 91.2, z * 0.00035 - 55.4)) * 0.7);

    // 高处 -> 山色
    c.lerp(cMtn, smoothstep(45, 230, y));
    // 极高峰顶偏灰
    tmp.copy(cMtn).lerp(cAlt, 0.25);
    c.lerp(tmp, smoothstep(260, 420, y) * 0.6);

    // 陡坡露岩
    const slope = 1 - clamp(nor.getY(i), 0, 1);
    c.lerp(cMtn, smoothstep(0.16, 0.48, slope) * 0.75);

    // 近水处偏深（湖岸 / 低洼）
    if (y < 6) c.multiplyScalar(1 - 0.22 * smoothstep(6, -4, y));

    // 随机微扰，避免大面积死板
    const j = 0.94 + 0.12 * hash2(Math.round(x * 0.7), Math.round(z * 0.7));
    colors[i * 3] = c.r * j;
    colors[i * 3 + 1] = c.g * j;
    colors[i * 3 + 2] = c.b * j;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

// ===========================================================================
// 6. 跑道 + 标线
// ===========================================================================

function buildRunway() {
  const group = new THREE.Group();
  group.name = 'runway';

  const surf = [];
  const edges = [];
  const whites = [];

  // 道面（略微超出两端，跑道 Pad 缓冲区也能看见）
  quad(surf, 0, 0, WORLD.runwayWidth, RW_LEN, RW_Y);

  // 白色边线（两侧）
  quad(edges, -(RW_HW - 2.2), 0, 0.9, RW_LEN, RW_Y + 0.04);
  quad(edges, (RW_HW - 2.2), 0, 0.9, RW_LEN, RW_Y + 0.04);

  // 中心虚线：段 12m，间隔 20m（20m 周期）
  for (let z = -1420; z <= 1420; z += 20) {
    quad(whites, 0, z, 0.9, 12, RW_Y + 0.04);
  }

  // 两端入口斑马线：8 道横向白条
  for (let end = 0; end < 2; end++) {
    const sgn = end === 0 ? -1 : 1;             // -1 = 南端(-Z)，+1 = 北端(+Z)
    for (let i = 0; i < 8; i++) {
      const x = -13.5 + i * 3.86;
      const z = sgn * (RW_LEN / 2 - 21);
      quad(whites, x, z, 1.9, 24, RW_Y + 0.04);
    }
    // 接地带标记：3 组（3 / 2 / 3 根粗白条），沿跑道中心线对称
    const groups = [[3, 300], [2, 500], [3, 700]];
    for (const [cnt, dist] of groups) {
      for (let i = 0; i < cnt; i++) {
        const x = (i - (cnt - 1) / 2) * 4.4;
        const z = sgn * (RW_LEN / 2 - dist);
        quad(whites, x, z, 2.3, 22, RW_Y + 0.04);
      }
    }
  }

  const matSurface = new THREE.MeshLambertMaterial({ color: PALETTE.runway, flatShading: true });
  const matEdge = new THREE.MeshLambertMaterial({
    color: PALETTE.runwayEdge, flatShading: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  const matWhite = new THREE.MeshLambertMaterial({
    color: PALETTE.markWhite, flatShading: true,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
  });

  const mSurf = meshOf(surf, matSurface, 'runwaySurface');
  const mEdge = meshOf(edges, matEdge, 'runwayEdgeLine');
  const mWhite = meshOf(whites, matWhite, 'runwayMarkings');
  mSurf.receiveShadow = true;
  mEdge.receiveShadow = true;
  mWhite.receiveShadow = true;
  group.add(mSurf, mEdge, mWhite);

  // 跑道号：北端(+Z) 降落航向 360° -> "36"；南端(-Z) -> "18"
  group.add(makeRunwayNumber('36', 1));
  group.add(makeRunwayNumber('18', -1));

  return group;
}

function makeRunwayNumber(text, sgn) {
  const tex = makeNumberTexture(text);
  const mat = new THREE.MeshLambertMaterial({
    map: tex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6
  });
  const g = new THREE.PlaneGeometry(13, 19.5);
  g.rotateX(-Math.PI / 2);              // 法线 +Y，纹理上方 -> 世界 -Z
  if (sgn > 0) g.rotateY(Math.PI);      // 北端需绕竖轴转 180° 才朝向 +Z 进近方向
  g.translate(0, RW_Y + 0.08, sgn * (RW_LEN / 2 - 48));
  const m = new THREE.Mesh(g, mat);
  m.name = 'runwayNumber' + text;
  m.renderOrder = 2;
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  return m;
}

// ===========================================================================
// 7. 滑行道 / 停机坪 / 等待位置标线
// ===========================================================================

const TW_X = 130;        // 平行滑行道中心距跑道中线
const TW_W = 20;         // 滑行道宽
const TW_Z0 = -1300;
const TW_Z1 = 1300;
const CONNECTORS = [-1150, -750, -350, 50, 450, 850, 1250];

function buildTaxiways() {
  const group = new THREE.Group();
  group.name = 'taxiways';

  const surf = [];
  const yellow = [];

  for (const s of [-1, 1]) {
    // 平行滑行道
    quad(surf, s * TW_X, (TW_Z0 + TW_Z1) / 2, TW_W, TW_Z1 - TW_Z0, RW_Y);
    quad(yellow, s * TW_X, (TW_Z0 + TW_Z1) / 2, 0.9, TW_Z1 - TW_Z0, RW_Y + 0.04);

    for (const cz of CONNECTORS) {
      // 连接道（跑道边缘 -> 滑行道）
      const inner = RW_HW - 1;
      const outer = TW_X - TW_W / 2;
      quad(surf, s * (inner + outer) / 2, cz, outer - inner, TW_W, RW_Y);
      quad(yellow, s * (inner + outer) / 2, cz, outer - inner, 0.9, RW_Y + 0.04);

      // 等待位置标线：2 实线 + 2 虚线（垂直于滑行道方向，沿 X 跨越道宽）
      for (let i = 0; i < 2; i++) {
        quad(yellow, s * TW_X, cz - 46 - i * 7, TW_W + 2, 0.9, RW_Y + 0.04);
      }
      for (let i = 0; i < 4; i++) {
        quad(yellow, s * TW_X, cz - 32 + i * 2.4, TW_W + 2, 1.2, RW_Y + 0.04);
      }
    }
  }

  // 停机坪：航站楼侧（西）+ 机库侧（东）
  quad(surf, -380, 0, 460, 1180, RW_Y);
  quad(surf, 390, -1080, 540, 620, RW_Y);
  // 停机坪滑行引导线（只连接滑行道与坪面，不压跑道）
  quad(yellow, -215, -420, 170, 0.9, RW_Y + 0.04);
  quad(yellow, -215, 420, 170, 0.9, RW_Y + 0.04);
  quad(yellow, -330, -300, 0.9, 520, RW_Y + 0.04);
  quad(yellow, -330, 300, 0.9, 520, RW_Y + 0.04);
  quad(yellow, -480, 0, 0.9, 900, RW_Y + 0.04);
  quad(yellow, 265, -1080, 270, 0.9, RW_Y + 0.04);
  quad(yellow, 420, -1080, 0.9, 480, RW_Y + 0.04);
  quad(yellow, 560, -1080, 0.9, 480, RW_Y + 0.04);

  const matSurface = new THREE.MeshLambertMaterial({ color: PALETTE.taxiway, flatShading: true });
  const matYellow = new THREE.MeshLambertMaterial({
    color: PALETTE.markYellow, flatShading: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });

  const mS = meshOf(surf, matSurface, 'taxiwaySurface');
  const mY = meshOf(yellow, matYellow, 'taxiwayMarkings');
  mS.receiveShadow = true;
  mY.receiveShadow = true;
  group.add(mS, mY);
  return group;
}

// ===========================================================================
// 8. 航站楼 + 指廊
// ===========================================================================

const TERM = { x: -700, z: 0, sx: 90, sz: 400, h: 24 };

function buildTerminal(colliders) {
  const group = new THREE.Group();
  group.name = 'terminal';

  const wall = [];
  const roof = [];
  const glass = [];
  const equip = [];

  const tx = TERM.x, tz = TERM.z;
  const halfX = TERM.sx / 2, halfZ = TERM.sz / 2;

  // 主体
  box(wall, tx, TERM.h / 2, tz, TERM.sx, TERM.h, TERM.sz);
  box(roof, tx, TERM.h + 1.6, tz, TERM.sx + 12, 3.2, TERM.sz + 16);
  // 基座
  box(wall, tx, 3, tz, TERM.sx + 8, 6, TERM.sz + 8);

  // 玻璃幕墙（朝跑道一侧 + 两端）
  box(glass, tx + halfX + 0.6, TERM.h / 2 + 2, tz, 1.2, TERM.h - 4, TERM.sz - 10);
  box(glass, tx - halfX - 0.6, TERM.h / 2 + 2, tz, 1.2, TERM.h - 4, TERM.sz - 10);
  box(glass, tx, TERM.h / 2 + 2, tz + halfZ + 0.6, TERM.sx - 10, TERM.h - 4, 1.2);
  box(glass, tx, TERM.h / 2 + 2, tz - halfZ - 0.6, TERM.sx - 10, TERM.h - 4, 1.2);

  // 屋顶设备
  for (let i = 0; i < 10; i++) {
    const gx = tx - halfX + 12 + (i % 5) * ((TERM.sx - 24) / 4);
    const gz = tz - halfZ + 40 + Math.floor(i / 5) * (TERM.sz - 80);
    box(equip, gx, TERM.h + 5.5, gz, 9, 5, 7);
  }
  box(equip, tx, TERM.h + 8, tz + 150, 3, 10, 3);   // 天线杆

  // 指廊（伸向跑道）
  const pierZ = [-150, 0, 150];
  for (const pz of pierZ) {
    const px0 = tx + halfX;            // -655
    const len = 180;
    const cx = px0 + len / 2;
    box(wall, cx, 7.5, pz, len, 15, 38);
    box(roof, cx, 16.4, pz, len + 6, 2.8, 42);
    box(glass, cx, 8, pz + 19.6, len - 12, 9, 1.2);
    box(glass, cx, 8, pz - 19.6, len - 12, 9, 1.2);
    // 廊桥
    for (let k = -1; k <= 1; k += 2) {
      box(equip, px0 + len + 9, 6, pz + k * 10, 18, 5, 4);
    }
    colliders.push({
      minX: cx - len / 2, maxX: cx + len / 2,
      minY: 0, maxY: 19,
      minZ: pz - 21, maxZ: pz + 21
    });
  }

  colliders.push({
    minX: tx - halfX - 5, maxX: tx + halfX + 5,
    minY: 0, maxY: TERM.h + 4,
    minZ: tz - halfZ - 9, maxZ: tz + halfZ + 9
  });

  group.add(meshOf(wall, new THREE.MeshLambertMaterial({ color: PALETTE.buildingWall, flatShading: true }), 'termWall'));
  group.add(meshOf(roof, new THREE.MeshLambertMaterial({ color: PALETTE.buildingRoof, flatShading: true }), 'termRoof'));
  group.add(meshOf(glass, new THREE.MeshPhongMaterial({
    color: PALETTE.buildingGlass, flatShading: true,
    emissive: PALETTE.buildingGlass, emissiveIntensity: 0.18,
    shininess: 90, specular: PALETTE.sunColor
  }), 'termGlass'));
  group.add(meshOf(equip, new THREE.MeshLambertMaterial({ color: PALETTE.engine, flatShading: true }), 'termEquip'));

  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return group;
}

// ===========================================================================
// 9. 塔台
// ===========================================================================

const TOWER = { x: -540, z: 330, h: 60 };

function buildTower(colliders) {
  const group = new THREE.Group();
  group.name = 'tower';
  const x = TOWER.x, z = TOWER.z;

  // 锥台塔身
  const shaft = new THREE.CylinderGeometry(9, 15, 42, 10, 1, false);
  shaft.translate(x, 21, z);
  const shaftMesh = new THREE.Mesh(shaft,
    new THREE.MeshLambertMaterial({ color: PALETTE.buildingWall, flatShading: true }));
  shaftMesh.name = 'towerShaft';
  group.add(shaftMesh);

  // 观察层挑檐
  const ring = new THREE.CylinderGeometry(16, 16, 3, 10);
  ring.translate(x, 43.5, z);
  const ringMesh = new THREE.Mesh(ring,
    new THREE.MeshLambertMaterial({ color: PALETTE.buildingRoof, flatShading: true }));
  group.add(ringMesh);

  // 斜面玻璃观察层
  const cab = new THREE.CylinderGeometry(13.5, 11, 11, 10, 1, true);
  cab.translate(x, 50, z);
  const cabMesh = new THREE.Mesh(cab, new THREE.MeshPhongMaterial({
    color: PALETTE.buildingGlass, flatShading: true, side: THREE.DoubleSide,
    emissive: PALETTE.buildingGlass, emissiveIntensity: 0.26,
    shininess: 110, specular: PALETTE.sunColor
  }));
  cabMesh.name = 'towerCab';
  group.add(cabMesh);

  // 顶盖
  const cap = new THREE.CylinderGeometry(14, 14, 2.6, 10);
  cap.translate(x, 57, z);
  const capMesh = new THREE.Mesh(cap,
    new THREE.MeshLambertMaterial({ color: PALETTE.buildingRoof, flatShading: true }));
  group.add(capMesh);

  // 航空障碍灯（红色，常亮）
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 8, 6),
    new THREE.MeshBasicMaterial({ color: PALETTE.navLeft })
  );
  beacon.position.set(x, TOWER.h, z);
  beacon.name = 'towerBeacon';
  group.add(beacon);

  group.traverse(o => { if (o.isMesh && o !== beacon) { o.castShadow = true; o.receiveShadow = true; } });

  colliders.push({
    minX: x - 17, maxX: x + 17,
    minY: 0, maxY: TOWER.h + 2,
    minZ: z - 17, maxZ: z + 17
  });
  return group;
}

// ===========================================================================
// 10. 机库（2 座，半圆柱顶）
// ===========================================================================

function buildHangars(colliders) {
  const group = new THREE.Group();
  group.name = 'hangars';

  const wall = [];
  const roof = [];
  const door = [];

  const specs = [
    { x: 430, z: -1000, sx: 70, sz: 170, h: 22 },
    { x: 430, z: -1200, sx: 70, sz: 170, h: 22 }
  ];

  for (const s of specs) {
    box(wall, s.x, s.h / 2, s.z, s.sx, s.h, s.sz);
    // 大门（略凸出门面，形成深色洞口）
    box(door, s.x - s.sx / 2 - 0.4, 9, s.z, 1.4, 18, 120);
    // 门楣雨棚
    box(roof, s.x - s.sx / 2 - 3, 19.5, s.z, 7, 1.6, 128);

    // 半圆柱拱顶（轴沿 Z，覆盖上半周）
    const R = s.sx / 2;
    const arc = new THREE.CylinderGeometry(R, R, s.sz, 14, 1, true, Math.PI / 2, Math.PI);
    arc.rotateX(Math.PI / 2);
    arc.translate(s.x, s.h, s.z);
    const arcMesh = new THREE.Mesh(arc, new THREE.MeshLambertMaterial({
      color: PALETTE.buildingRoof, flatShading: true, side: THREE.DoubleSide
    }));
    arcMesh.name = 'hangarRoof';
    group.add(arcMesh);

    colliders.push({
      minX: s.x - s.sx / 2 - 5, maxX: s.x + s.sx / 2 + 5,
      minY: 0, maxY: s.h + R,
      minZ: s.z - s.sz / 2, maxZ: s.z + s.sz / 2
    });
  }

  group.add(meshOf(wall, new THREE.MeshLambertMaterial({ color: PALETTE.buildingWall, flatShading: true }), 'hangarWall'));
  group.add(meshOf(door, new THREE.MeshLambertMaterial({ color: PALETTE.skybridge, flatShading: true }), 'hangarDoor'));

  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return group;
}

// ===========================================================================
// 11. 水面（湖）
// ===========================================================================

function buildWater() {
  const group = new THREE.Group();
  group.name = 'water';

  const geo = new THREE.CircleGeometry(LAKE.r * 0.92, 56);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshPhongMaterial({
    color: PALETTE.water,
    emissive: PALETTE.water, emissiveIntensity: 0.10,
    shininess: 140, specular: PALETTE.skyHorizon,
    transparent: true, opacity: 0.86, depthWrite: false
  });
  const lake = new THREE.Mesh(geo, mat);
  lake.position.set(LAKE.x, LAKE.y, LAKE.z);
  lake.name = 'lake';
  lake.renderOrder = 1;
  group.add(lake);
  return group;
}

// ===========================================================================
// 12. 树林（InstancedMesh，2 个 draw call）
// ===========================================================================

const TREE_COUNT = 560;

function buildTrees() {
  const group = new THREE.Group();
  group.name = 'trees';

  // 共享几何体：树冠（基点在原点，便于随风摆动）+ 树干
  const foliageGeo = new THREE.ConeGeometry(2.7, 7.6, 6, 1);
  foliageGeo.translate(0, 3.8, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.45, 0.75, 2.6, 5, 1);
  trunkGeo.translate(0, 1.3, 0);

  const foliageMat = new THREE.MeshLambertMaterial({ color: PALETTE.groundAlt, flatShading: true });
  const trunkMat = new THREE.MeshLambertMaterial({ color: PALETTE.hemiGround, flatShading: true });

  const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, TREE_COUNT);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, TREE_COUNT);
  foliage.name = 'treeFoliage';
  trunks.name = 'treeTrunks';
  foliage.castShadow = true;
  trunks.castShadow = false;
  foliage.receiveShadow = false;
  foliage.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // 随机分布：避开机场区、避开航道走廊、避开高山区与湖面
  const base = [];
  const mtx = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const eul = new THREE.Euler();
  const cFoliage = new THREE.Color();
  const baseCol = new THREE.Color(PALETTE.groundAlt);
  const darkCol = new THREE.Color(PALETTE.mountain);
  const warmCol = new THREE.Color(PALETTE.ground);

  let seed = 20261003;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return ((seed >>> 8) & 0xffffff) / 0xffffff;
  };

  let placed = 0, guard = 0;
  while (placed < TREE_COUNT && guard < TREE_COUNT * 40) {
    guard++;
    const a = rnd() * Math.PI * 2;
    const r = 1500 + Math.pow(rnd(), 0.62) * 9200;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r * 1.15 + 400;

    // 机场矩形 / 停机坪 / 航道走廊
    if (Math.abs(x) < 1500 && z > -2400 && z < 2800) continue;
    // 起飞爬升走廊（CP1 上方）保持净空
    if (Math.abs(x) < 800 && z > -1700 && z < 1500) continue;
    // 远景城市天际线区域留给建筑
    if (Math.abs(x) > 3400 && Math.abs(z) < 1400) continue;
    const h = terrainHeight(x, z);
    if (h < 1.5 || h > 170) continue;                 // 湖面 / 高山不长树

    const s = 0.7 + rnd() * 0.95;
    const rotY = rnd() * Math.PI * 2;
    pos.set(x, h - 0.3, z);
    eul.set(0, rotY, 0);
    quat.setFromEuler(eul);
    scl.set(s, s * (0.85 + rnd() * 0.5), s);
    mtx.compose(pos, quat, scl);
    trunks.setMatrixAt(placed, mtx);
    foliage.setMatrixAt(placed, mtx);

    const t = rnd();
    cFoliage.copy(baseCol).lerp(darkCol, t * 0.75).lerp(warmCol, (1 - t) * 0.28);
    foliage.setColorAt(placed, cFoliage);

    // 摆动所需的基础数据（xz 缩放复用 sx）
    base.push(x, h - 0.3, z, rotY, s, scl.y);
    placed++;
  }

  foliage.count = placed;
  trunks.count = placed;
  foliage.instanceMatrix.needsUpdate = true;
  trunks.instanceMatrix.needsUpdate = true;
  if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
  foliage.computeBoundingSphere();

  group.add(trunks, foliage);
  group.userData = { base, count: placed, foliage };
  return group;
}

// ===========================================================================
// 13. 远景城市天际线（InstancedMesh，1 个 draw call）
// ===========================================================================

const CITY_COUNT = 132;

function buildCity() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshLambertMaterial({ color: PALETTE.cityFar, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, CITY_COUNT);
  mesh.name = 'citySkyline';

  const mtx = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const c = new THREE.Color();
  const cA = new THREE.Color(PALETTE.cityFar);
  const cB = new THREE.Color(PALETTE.skybridge);
  const cC = new THREE.Color(PALETTE.buildingWall);

  let seed = 777001;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return ((seed >>> 8) & 0xffffff) / 0xffffff;
  };

  let placed = 0, guard = 0;
  while (placed < CITY_COUNT && guard < CITY_COUNT * 60) {
    guard++;
    const side = rnd() < 0.5 ? -1 : 1;
    const x = side * (3600 + Math.pow(rnd(), 0.7) * 6400);
    const z = -2600 + rnd() * 13000;
    const d = Math.hypot(x, z);
    if (d < 6000 || d > 10200) continue;
    if (Math.abs(x) < 3400) continue;                    // 让开航道
    if (Math.abs(x - LAKE.x) < LAKE.r * 2.2 && Math.abs(z - LAKE.z) < LAKE.r * 2.2) continue;

    const h = terrainHeight(x, z);
    const tall = Math.pow(rnd(), 1.9);
    const height = 45 + tall * 215;
    const w = 34 + rnd() * 52;
    const dpt = 34 + rnd() * 52;

    pos.set(x, h + height / 2 - 12, z);
    quat.identity();
    scl.set(w, height, dpt);
    mtx.compose(pos, quat, scl);
    mesh.setMatrixAt(placed, mtx);

    const t = rnd();
    c.copy(cA).lerp(cB, t * 0.55).lerp(cC, Math.max(0, t - 0.7) * 1.4);
    mesh.setColorAt(placed, c);
    placed++;
  }

  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

// ===========================================================================
// 14. 农田色块（贴合地形起伏的薄板）
// ===========================================================================

const FIELDS = [
  { x: 2250, z: 1750, w: 950, d: 720, tint: 0.18 },
  { x: 3500, z: 780, w: 820, d: 980, tint: 0.52 },
  { x: -2650, z: 2150, w: 1000, d: 820, tint: 0.80 },
  { x: -3900, z: 1150, w: 900, d: 1150, tint: 0.34 },
  { x: 2650, z: -1900, w: 1150, d: 820, tint: 0.92 },
  { x: -2450, z: -2050, w: 900, d: 940, tint: 0.62 },
  { x: 4700, z: 3050, w: 1000, d: 900, tint: 0.10 },
  { x: -4700, z: -2600, w: 1100, d: 800, tint: 0.44 }
];

function buildFields() {
  const group = new THREE.Group();
  group.name = 'farmland';

  const cA = new THREE.Color(PALETTE.ground);
  const cB = new THREE.Color(PALETTE.groundAlt);
  const cC = new THREE.Color(PALETTE.markYellow);
  const cD = new THREE.Color(PALETTE.hemiGround);
  const c = new THREE.Color();

  for (let i = 0; i < FIELDS.length; i++) {
    const f = FIELDS[i];
    const geo = new THREE.PlaneGeometry(f.w, f.d, 8, 8);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const wx = p.getX(k) + f.x;
      const wz = p.getZ(k) + f.z;
      p.setY(k, terrainHeight(wx, wz) + 0.22);
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    // 色调：green↔alt，一块掺入枯黄（取自 PALETTE 的插值）
    c.copy(cA).lerp(cB, f.tint);
    if (i % 3 === 0) c.lerp(cC, 0.20);
    if (i % 4 === 1) c.lerp(cD, 0.16);
    const mat = new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    const m = new THREE.Mesh(geo, mat);
    m.name = 'field' + i;
    m.receiveShadow = true;
    group.add(m);
  }
  return group;
}

// ===========================================================================
// 15. 光照
// ===========================================================================

function buildLights(scene) {
  const sun = new THREE.DirectionalLight(PALETTE.sunColor, 2.2);
  sun.name = 'sunLight';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const d = 340;                       // 正交阴影相机半边长 -> 覆盖飞机周围约 680m
  sun.shadow.camera.left = -d;
  sun.shadow.camera.right = d;
  sun.shadow.camera.top = d;
  sun.shadow.camera.bottom = -d;
  sun.shadow.camera.near = 400;
  sun.shadow.camera.far = 2400;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.9;
  sun.position.copy(SUN_DIR).multiplyScalar(1400);
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 0.85);
  hemi.name = 'hemiLight';
  scene.add(hemi);

  const amb = new THREE.AmbientLight(PALETTE.fog, 0.22);
  amb.name = 'ambientLight';
  scene.add(amb);

  return { sun, hemi, amb };
}

// ===========================================================================
// 16. 组装
// ===========================================================================

export function createEnvironment(scene) {
  const root = new THREE.Group();
  root.name = 'environment';
  scene.add(root);

  // 雾 + 背景
  scene.fog = new THREE.Fog(PALETTE.fog, 1500, 22000);
  scene.background = new THREE.Color(PALETTE.fog);

  const colliders = [];

  const sky = buildSky();
  const terrain = buildTerrain();
  const runwayGroup = buildRunway();
  const taxiGroup = buildTaxiways();
  const terminal = buildTerminal(colliders);
  const tower = buildTower(colliders);
  const hangars = buildHangars(colliders);
  const water = buildWater();
  const trees = buildTrees();
  const city = buildCity();
  const fields = buildFields();
  const lights = buildLights(scene);

  root.add(sky, terrain, runwayGroup, taxiGroup, terminal, tower, hangars, water, trees, city, fields);

  // ---- 动画 / 每帧更新所需状态 ----
  const treeBase = trees.userData.base;
  const treeMesh = trees.userData.foliage;
  const treeCount = trees.userData.count;
  const waterMat = water.getObjectByName('lake').material;
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _e = new THREE.Euler();
  const _plane = new THREE.Vector3();
  const SUN_FAR = 1400;
  const STRIDE = 6;                    // base: x,y,z,rotY,sx,sy  (sz 由 sx 复用)

  function update(dt, elapsed, planePos) {
    if (planePos) {
      _plane.copy(planePos);
    }
    const px = _plane.x, py = _plane.y, pz = _plane.z;

    // 阴影相机跟随飞机：light 与 target 一起平移，保持 680m 覆盖
    lights.sun.target.position.set(px, Math.max(py, 0), pz);
    lights.sun.position.set(
      px + SUN_DIR.x * SUN_FAR,
      Math.max(py, 0) + SUN_DIR.y * SUN_FAR,
      pz + SUN_DIR.z * SUN_FAR
    );
    lights.sun.target.updateMatrixWorld();

    // 天空穹顶跟随（XZ 平面），保证相机永远在球内
    sky.position.set(px, 0, pz);

    // 湖面轻微起伏 + 反光变化
    const lake = water.getObjectByName('lake');
    lake.position.y = LAKE.y + Math.sin(elapsed * 0.45) * 0.14;
    waterMat.opacity = 0.82 + Math.sin(elapsed * 0.7) * 0.05;
    waterMat.emissiveIntensity = 0.09 + Math.sin(elapsed * 0.5) * 0.035;

    // 树梢随风摆动（只更新树冠，1 个 InstancedMesh）
    const t = elapsed;
    for (let i = 0; i < treeCount; i++) {
      const o = i * STRIDE;
      const x = treeBase[o], y = treeBase[o + 1], z = treeBase[o + 2];
      const rotY = treeBase[o + 3];
      const sx = treeBase[o + 4], sy = treeBase[o + 5];
      const ph = x * 0.031 + z * 0.017;
      const sway = Math.sin(t * 1.15 + ph) * 0.030 + Math.sin(t * 2.3 + ph * 1.7) * 0.011;
      _p.set(x, y, z);
      _e.set(sway, rotY, sway * 0.6);
      _q.setFromEuler(_e);
      _s.set(sx, sy, sx);
      _m.compose(_p, _q, _s);
      treeMesh.setMatrixAt(i, _m);
    }
    treeMesh.instanceMatrix.needsUpdate = true;
  }

  // 让首帧阴影/天空位置就位
  update(0, 0, null);

  function stats() {
    let meshes = 0;
    root.traverse(o => { if (o.isMesh || o.isInstancedMesh) meshes++; });
    return { meshes: meshes, trees: treeCount, colliders: colliders.length };
  }

  return {
    colliders: colliders,
    runway: {
      minZ: -RW_LEN / 2,
      maxZ: RW_LEN / 2,
      halfWidth: RW_HW,
      y: WORLD.runwayY
    },
    update: update,
    stats: stats
  };
}
