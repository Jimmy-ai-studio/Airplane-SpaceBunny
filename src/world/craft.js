/**
 * 可辨认的窄体客机（A320 级比例，1:1 真实尺寸）—— 全部程序化几何，无外部资源。
 *
 * 局部坐标约定：+Z 机头，+Y 上，+X 右翼。group 的姿态由主循环用 model.quat
 * 直接设置，本模块内部不再自转机体，只在 bodyRoot（机身子节点）上做
 * 接地压缩 / 失速抖动等附加位移与微转。
 *
 * 竖直布局（局部坐标，地面 = PHYS.gearHeight = 2.8m）：
 *   地面 y=-2.80 | 主轮中心 y=-2.18 | 发动机下缘 y=-2.52
 *   腹部整流罩下缘 y=-1.80 | 机身中心 y=+0.85（最大半径 2.0）
 *   机身顶 y=+2.85 | 垂尾顶 y=+9.20（离地 12.0m）
 *
 * 造型要点（保证「一眼看出是客机」）：
 *   - 机身 37m × 4m（长径比 9.3:1），环形放样，尾锥上翘
 *   - 机翼 / 垂尾 / 平尾 / 翼尖小翼全部 NACA 翼型放样 → 真实厚度 + 后掠 + 上反
 *   - 发动机 = 短舱 + 白色进气唇口 + 深色内涵道 + 风扇盘(旋转) + 尾喷口 + 挂架
 *   - 腹部整流罩 + 3 个襟翼滑轨整流罩 → 窄体机最强的识别特征
 */

import * as THREE from '../../vendor/three.module.js';
import { PALETTE } from '../core/constants.js';

const DEG = Math.PI / 180;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp;
/** 指数缓动：tau 秒内走完约 63% */
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);

// ================================================================ 机身站位表
// [z, r, cy] —— 机头在 +Z，尾锥在 -Z。cy = 该处轴线抬高量（尾段上翘）。
// 机头用「钝头」剖面：最后 3m 半径只收到 0.30，形成真实客机的圆钝雷达罩，
// 而不是战斗机式的尖锥。
const FUSE_CY = 0.85;
const FUSE = [
  [-18.60, 0.05, 1.50], [-17.80, 0.26, 1.42], [-16.90, 0.48, 1.31],
  [-15.70, 0.72, 1.16], [-14.30, 0.97, 0.98], [-12.70, 1.22, 0.78],
  [-11.00, 1.46, 0.58], [-9.20, 1.66, 0.35], [-7.00, 1.82, 0.17],
  [-4.50, 1.93, 0.06], [-2.00, 1.99, 0.02], [0.50, 2.00, 0.00],
  [3.00, 2.00, 0.00], [5.50, 1.99, 0.00], [7.50, 1.97, 0.00],
  [9.20, 1.92, 0.00], [10.60, 1.84, -0.01], [11.80, 1.74, -0.02],
  [12.90, 1.62, -0.03], [13.90, 1.47, -0.05], [14.80, 1.28, -0.07],
  [15.60, 1.08, -0.10], [16.35, 0.86, -0.13], [16.95, 0.66, -0.16],
  [17.45, 0.46, -0.19], [17.80, 0.30, -0.21],
];
const FUSE_SEG = 24;                 // 周向分段

/** 机身半径 / 轴线高度插值（含 dr/dz、dcy/dz 供法线用） */
function fuseAt(z) {
  const last = FUSE.length - 1;
  let i = 0;
  while (i < last - 1 && FUSE[i + 1][0] < z) i++;
  const a = FUSE[i], b = FUSE[Math.min(i + 1, last)];
  const dz = (b[0] - a[0]) || 1;
  const t = clamp((z - a[0]) / dz, 0, 1);
  return {
    r: a[1] + (b[1] - a[1]) * t,
    cy: FUSE_CY + a[2] + (b[2] - a[2]) * t,
    dr: (b[1] - a[1]) / dz,
    dcy: (b[2] - a[2]) / dz,
  };
}
/** 机身表面点：th 从机顶起算（0=顶，90=右侧） */
function fusePoint(z, th, out = 0) {
  const f = fuseAt(z);
  const r = Math.max(f.r + out, 0.004);
  return V(Math.sin(th) * r, f.cy + Math.cos(th) * r, z);
}
function fuseNormal(z, th) {
  const f = fuseAt(z);
  return V(Math.sin(th), Math.cos(th), -(Math.cos(th) * f.dcy + f.dr)).normalize();
}
const fuseTanTh = (th) => V(Math.cos(th), -Math.sin(th), 0);          // 周向
const fuseTanZ = (z, th) => {                                          // 子午线
  const f = fuseAt(z);
  return V(f.dr * Math.sin(th), f.dcy + f.dr * Math.cos(th), 1).normalize();
};

// ================================================================ 通用几何工具
/**
 * 放样：把若干「截面」缝成闭合壳体，并按有向体积自动修正绕序（保证正面朝外）。
 * section = { o: 原点, cd: 弦向单位向量, td: 厚度向单位向量, pts: [[弦向,厚度向],...] }
 */
function loft(sections, capA = true, capB = true) {
  const n = sections[0].pts.length;
  const pos = [];
  for (const s of sections) {
    for (const p of s.pts) {
      pos.push(
        s.o.x + s.cd.x * p[0] + s.td.x * p[1],
        s.o.y + s.cd.y * p[0] + s.td.y * p[1],
        s.o.z + s.cd.z * p[0] + s.td.z * p[1],
      );
    }
  }
  const idx = [];
  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      const a = i * n + j, b = i * n + j2, c = (i + 1) * n + j, d = (i + 1) * n + j2;
      idx.push(a, c, b, b, c, d);
    }
  }
  const capFan = (secIdx, rev) => {
    const base = secIdx * n;
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < n; j++) { const k = (base + j) * 3; cx += pos[k]; cy += pos[k + 1]; cz += pos[k + 2]; }
    const ci = pos.length / 3;
    pos.push(cx / n, cy / n, cz / n);
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      if (rev) idx.push(ci, base + j2, base + j); else idx.push(ci, base + j, base + j2);
    }
  };
  // 侧壁在首截面沿 j2→j、末截面沿 j→j2，端盖绕序须与之相反
  if (capA) capFan(0, false);
  if (capB) capFan(sections.length - 1, true);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const p = g.attributes.position.array, ix = g.index.array;
  let vol = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    vol += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
         - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
         + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (vol < 0) for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  g.computeVertexNormals();
  return g;
}

/** NACA 风格闭合翼型剖面（弦长归一为 1），返回 [[弦向 0..1, 厚度向], ...] 环 */
function foil(n, t, m = 0.016) {
  const p = 0.4;
  const up = [], lo = [];
  for (let i = 0; i <= n; i++) {
    const x = 0.5 * (1 - Math.cos(Math.PI * i / n));
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x
      + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
    let yc, dy;
    if (x < p) { yc = m / (p * p) * (2 * p * x - x * x); dy = 2 * m / (p * p) * (p - x); }
    else { yc = m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * x - x * x); dy = 2 * m / ((1 - p) * (1 - p)) * (p - x); }
    const th = Math.atan(dy);
    up.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lo.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  const loop = up.slice();
  for (let i = n - 1; i >= 1; i--) loop.push(lo[i]);
  return loop;
}

/**
 * 翼型截面。cd 指向弦线后方（-Z），td 为厚度向。
 * tw = 扭转角(正=前缘上)，ct = 上翘角(cant，用于翼尖小翼)，mir = ±1 镜像。
 * 镜像通过翻转基向量实现（不用负缩放，避免面被背面剔除）。
 */
function wingSec(x, y, leZ, chord, tRatio, tw = 0, ct = 0, mir = 1, nPts = 8) {
  const a = tw * DEG, b = ct * DEG;
  const cd = V(-Math.sin(a) * Math.sin(b), Math.sin(a) * Math.cos(b), -Math.cos(a));
  const td = V(-Math.cos(a) * Math.sin(b), Math.cos(a) * Math.cos(b), Math.sin(a));
  if (mir < 0) { cd.x = -cd.x; td.x = -td.x; }
  return {
    o: V(mir * x, y, leZ), cd, td,
    pts: foil(nPts, tRatio).map(p => [p[0] * chord, p[1] * chord]),
  };
}

/** 竖直翼面截面（垂尾 / 背鳍 / 挂架）：厚度沿 X，弦向 -Z */
function finSec(o, chord, tRatio, nPts = 8) {
  return {
    o, cd: V(0, 0, -1), td: V(1, 0, 0),
    pts: foil(nPts, tRatio).map(p => [p[0] * chord, p[1] * chord]),
  };
}

/** 机身表面上一块有厚度的弧形贴片（涂装带 / 风挡 / 标识） */
function skinSolid(zs, th0, th1, nseg, depth, off) {
  const secs = zs.map(z => {
    const f = fuseAt(z);
    const r = Math.max(f.r + off, 0.05);
    const ri = Math.max(r - depth, 0.02);
    const pts = [];
    for (let i = 0; i <= nseg; i++) {
      const a = th0 + (th1 - th0) * (i / nseg);
      pts.push([Math.sin(a) * r, f.cy + Math.cos(a) * r]);
    }
    for (let i = nseg; i >= 0; i--) {
      const a = th0 + (th1 - th0) * (i / nseg);
      pts.push([Math.sin(a) * ri, f.cy + Math.cos(a) * ri]);
    }
    return { o: V(0, 0, z), cd: V(1, 0, 0), td: V(0, 1, 0), pts };
  });
  return loft(secs, true, true);
}

/** 共面四边形组（客舱门 / 货舱门轮廓） */
function quadsToGeometry(items) {
  const pos = new Float32Array(items.length * 18);
  let o = 0;
  const v = [V(0, 0, 0), V(0, 0, 0), V(0, 0, 0), V(0, 0, 0)];
  for (const it of items) {
    v[0].copy(it.c).addScaledVector(it.s, -it.w / 2).addScaledVector(it.t, -it.h / 2);
    v[1].copy(it.c).addScaledVector(it.s, it.w / 2).addScaledVector(it.t, -it.h / 2);
    v[2].copy(it.c).addScaledVector(it.s, it.w / 2).addScaledVector(it.t, it.h / 2);
    v[3].copy(it.c).addScaledVector(it.s, -it.w / 2).addScaledVector(it.t, it.h / 2);
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos[o] = v[k].x; pos[o + 1] = v[k].y; pos[o + 2] = v[k].z; o += 3;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/** 机身表面平面标记：thDeg 距机顶夹角，w 沿机身轴向，h 沿周向 */
function skinQuad(zc, thDeg, w, h, off = 0.035) {
  const th = thDeg * DEG;
  return { c: fusePoint(zc, th, off), s: fuseTanZ(zc, th), t: fuseTanTh(th), w, h };
}

/** 合并若干几何体（减少 draw call） */
function mergeGeos(list) {
  let total = 0;
  const parts = list.map(g => (g.index ? g.toNonIndexed() : g));
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

// ================================================================ 主要尺寸
// 主翼站位 [x, y, leZ, chord, tRatio, twist, cant]
// 展长 2×16.9 = 33.8m（含小翼 2×17.66 = 35.3m），后掠 25°，上反 4.7°
const WING = [
  [1.90, -0.50, 3.60, 6.20, 0.080, 3.0, 0],
  [5.60, -0.19, 1.90, 5.40, 0.078, 2.2, 0],
  [9.50, 0.10, 0.15, 4.30, 0.074, 1.2, 0],
  [13.20, 0.38, -1.55, 3.10, 0.072, 0.3, 0],
  [16.00, 0.60, -2.85, 2.30, 0.070, -0.5, 0],
  [16.90, 0.72, -3.40, 1.85, 0.070, -0.8, 0],
];
// 翼尖小翼：向上翘起 2.3m，蓝色
const WLET = [
  [16.90, 0.72, -3.40, 1.85, 0.070, -0.8, 0],
  [17.10, 1.50, -3.60, 1.60, 0.068, -0.8, 58],
  [17.42, 2.45, -4.00, 1.15, 0.068, -0.8, 63],
  [17.66, 3.00, -4.35, 0.72, 0.072, -0.8, 66],
];
const ENG_X = 5.50, ENG_Y = -1.60, ENG_Z = 1.70;

// 操纵面：[x0, y0, leZ0, chord0, x1, y1, leZ1, chord1]
const FLAP_IN = [2.00, -0.494, -2.43, 1.90, 6.40, -0.157, -3.19, 1.75];
const FLAP_OU = [7.00, -0.122, -3.29, 1.70, 11.60, 0.283, -3.73, 1.50];
const AILERON = [12.40, 0.333, -4.02, 1.30, 16.40, 0.618, -4.95, 1.10];
const SPOIL_A = [7.60, 0.09, -2.65, 1.00, 10.00, 0.31, -3.26, 1.00];
const SPOIL_B = [10.60, 0.33, -3.22, 1.00, 13.00, 0.56, -3.72, 1.00];
const SLAT_IN = [2.20, -0.68, 3.89, 0.75, 6.00, -0.38, 2.17, 0.70];
const SLAT_OU = [6.80, -0.33, 2.00, 0.68, 11.80, 0.09, -0.08, 0.62];

/** 操纵面几何：secs=[x,y,leZ,chord,...]，pivot 为铰接点（局部原点） */
function surfaceGeo(secs, pivot, tRatio, mir) {
  return loft([
    wingSec(secs[0] - pivot.x, secs[1] - pivot.y, secs[2] - pivot.z, secs[3], tRatio, 0, 0, mir),
    wingSec(secs[4] - pivot.x, secs[5] - pivot.y, secs[6] - pivot.z, secs[7], tRatio, 0, 0, mir),
  ]);
}
const midOf = s => V((s[0] + s[4]) / 2, (s[1] + s[5]) / 2, (s[2] + s[6]) / 2);

// ================================================================ 主构建
export function createAircraft() {
  const group = new THREE.Group();
  group.name = 'aircraft';
  const bodyRoot = new THREE.Group();   // 承接受压下沉与失速抖动
  bodyRoot.name = 'aircraftBody';
  group.add(bodyRoot);

  // ---------------- 材质 ----------------
  const matBody = new THREE.MeshStandardMaterial({
    color: PALETTE.aircraftBody, roughness: 0.40, metalness: 0.16, flatShading: true,
  });
  const matAccent = new THREE.MeshStandardMaterial({
    color: PALETTE.aircraftAccent, roughness: 0.38, metalness: 0.22, flatShading: true,
  });
  const matAccent2 = new THREE.MeshStandardMaterial({
    color: PALETTE.aircraftAccent2, roughness: 0.45, metalness: 0.10, flatShading: true,
  });
  const matDark = new THREE.MeshStandardMaterial({
    color: PALETTE.aircraftDark, roughness: 0.74, metalness: 0.28, flatShading: true,
  });
  const matGlass = new THREE.MeshStandardMaterial({
    color: PALETTE.aircraftGlass, roughness: 0.10, metalness: 0.70,
    emissive: 0x0c1620, side: THREE.DoubleSide,
  });
  // 金属度要克制：场景里没有环境贴图（IBL），metalness 接近 1 的材质
  // 只剩高光、漫反射被吃光，会渲染成纯黑。0.2~0.35 才有金属质感又可见。
  const matEngine = new THREE.MeshStandardMaterial({
    color: PALETTE.engine, roughness: 0.38, metalness: 0.30, flatShading: true,
  });
  const matDuct = new THREE.MeshStandardMaterial({
    color: 0x2a2f36, roughness: 0.85, metalness: 0.18, side: THREE.DoubleSide,
  });
  const matMetal = new THREE.MeshStandardMaterial({
    color: 0x4a5058, roughness: 0.42, metalness: 0.32, flatShading: true,
  });
  const matTire = new THREE.MeshStandardMaterial({
    color: 0x22252a, roughness: 0.95, metalness: 0.02, flatShading: true,
  });
  const matHub = new THREE.MeshStandardMaterial({
    color: 0x8d949c, roughness: 0.34, metalness: 0.35, flatShading: true,
  });
  const matSmoke = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
  });
  const navLampMat = (c) => new THREE.MeshStandardMaterial({
    color: 0x101216, emissive: c, emissiveIntensity: 3.2, roughness: 0.35,
  });
  const matNavL = navLampMat(PALETTE.navLeft);
  const matNavR = navLampMat(PALETTE.navRight);
  const matNavT = navLampMat(0xffffff);
  const matStrobe = new THREE.MeshStandardMaterial({
    color: 0x141414, emissive: 0xffffff, emissiveIntensity: 0.0, roughness: 0.3,
  });
  const matBeacon = new THREE.MeshStandardMaterial({
    color: 0x180404, emissive: PALETTE.navLeft, emissiveIntensity: 0.0, roughness: 0.35,
  });
  const matWarn = new THREE.MeshStandardMaterial({
    color: 0x1a0505, emissive: PALETTE.navLeft, emissiveIntensity: 0.0, roughness: 0.4,
  });
  const matLanding = new THREE.MeshStandardMaterial({
    color: 0x1a1a14, emissive: 0xfff6d8, emissiveIntensity: 2.8, roughness: 0.3,
  });

  const add = (parent, geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  /** 左右成对添加：工厂函数接收 mir 生成几何（不用负缩放） */
  const addPair = (factory, mat) => {
    for (const mir of [1, -1]) add(bodyRoot, factory(mir), mat);
  };

  // ============================================================ 机身
  add(bodyRoot, loft(FUSE.map(s => {
    const pts = [];
    for (let i = 0; i < FUSE_SEG; i++) {
      const th = (i / FUSE_SEG) * Math.PI * 2;
      pts.push([Math.sin(th) * s[1], s[2] + FUSE_CY + Math.cos(th) * s[1]]);
    }
    return { o: V(0, 0, s[0]), cd: V(1, 0, 0), td: V(0, 1, 0), pts };
  })), matBody);

  // 蓝色机腹 + 橙色饰条（真实客机的典型涂装分层）
  add(bodyRoot, skinSolid(
    [-9.6, -6, -2, 2, 6, 9.6], 106 * DEG, 254 * DEG, 12, 0.07, 0.012), matAccent);
  for (const s of [1, -1]) {
    const a0 = s > 0 ? 94 * DEG : 266 * DEG;
    add(bodyRoot, skinSolid(
      [-9.8, -5, 0, 5, 10.2], a0, a0 + s * 12 * DEG, 2, 0.05, 0.028), matAccent2);
  }

  // 驾驶舱风挡：顶部主风挡 + 两侧侧风挡 + 雷达罩分界深色件
  add(bodyRoot, skinSolid([14.20, 15.05, 15.90], -46 * DEG, 46 * DEG, 8, 0.06, 0.02), matGlass);
  for (const s of [1, -1]) {
    const a0 = s > 0 ? 44 * DEG : 316 * DEG;
    add(bodyRoot, skinSolid([12.70, 13.45, 14.20], a0, a0 + s * 48 * DEG, 5, 0.06, 0.02), matGlass);
  }
  add(bodyRoot, skinSolid([15.90, 16.40, 17.20], -40 * DEG, 40 * DEG, 6, 0.05, 0.02), matDark);

  // 客舱门 / 货舱门轮廓
  add(bodyRoot, quadsToGeometry([
    skinQuad(9.90, 68, 1.85, 0.95), skinQuad(-8.70, 68, 1.85, 0.95),
    skinQuad(-6.60, 112, 2.60, 1.35),
  ]), matDark);

  // 舷窗排：每侧 30 扇（InstancedMesh，1 个 draw call）
  const WIN_N = 30;
  const windows = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.36, 0.42),
    new THREE.MeshStandardMaterial({
      color: PALETTE.aircraftGlass, roughness: 0.12, metalness: 0.65,
      emissive: 0x0a1017, side: THREE.DoubleSide,
    }),
    WIN_N * 2,
  );
  {
    const m4 = new THREE.Matrix4();
    const bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3();
    let k = 0;
    for (const s of [1, -1]) {
      for (let i = 0; i < WIN_N; i++) {
        const z = 9.55 - i * 0.62;
        const th = s * 70 * DEG;
        bz.copy(fuseNormal(z, th));
        bx.copy(fuseTanTh(th));
        by.crossVectors(bz, bx).normalize();
        bx.crossVectors(by, bz).normalize();
        m4.makeBasis(bx, by, bz);
        m4.setPosition(fusePoint(z, th, 0.03));
        windows.setMatrixAt(k++, m4);
      }
    }
    windows.instanceMatrix.needsUpdate = true;
  }
  bodyRoot.add(windows);

  // ============================================================ 腹部整流罩（翼身融合）
  const FAIR = [
    [8.80, 0.50, -0.40, -1.12], [6.50, 1.32, -0.22, -1.44], [3.50, 2.08, -0.10, -1.72],
    [0.00, 2.44, -0.04, -1.80], [-3.20, 2.46, -0.04, -1.78], [-6.00, 2.18, -0.14, -1.62],
    [-8.20, 1.52, -0.30, -1.34], [-10.00, 0.78, -0.46, -1.04], [-11.20, 0.26, -0.62, -0.84],
  ];
  add(bodyRoot, loft(FAIR.map(s => {
    const cy = (s[2] + s[3]) / 2, ry = (s[2] - s[3]) / 2;
    const pts = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      pts.push([Math.sin(a) * s[1], cy + Math.cos(a) * ry]);
    }
    return { o: V(0, 0, s[0]), cd: V(1, 0, 0), td: V(0, 1, 0), pts };
  })), matBody);

  // 襟翼滑轨整流罩（3 个/侧）—— 紧贴机翼下表面，稍稍外露一点即可，
  // 太鼓会看起来像挂了额外的短舱。
  for (const mir of [1, -1]) {
    for (const [fx, fy, fz, rx, ry, rz] of [
      [3.20, -0.50, -2.55, 0.42, 0.30, 1.90],
      [7.00, -0.52, -3.20, 0.38, 0.27, 1.70],
      [11.00, -0.56, -3.70, 0.34, 0.24, 1.50],
    ]) {
      const g = new THREE.SphereGeometry(1, 8, 5);
      g.scale(rx, ry, rz);
      add(bodyRoot, g, matBody, mir * fx, fy, fz);
    }
  }

  // ============================================================ 主翼 + 翼尖小翼
  addPair(mir => loft(WING.map(w => wingSec(w[0], w[1], w[2], w[3], w[4], w[5], w[6], mir))), matBody);
  addPair(mir => loft(WLET.map(w => wingSec(w[0], w[1], w[2], w[3], w[4], w[5], w[6], mir))), matAccent);

  // 副翼分缝深色细条
  addPair(mir => {
    const g = new THREE.BoxGeometry(4.10, 0.05, 0.10);
    g.translate(mir * 14.40, 0.50, -4.32);
    return g;
  }, matDark);

  // ============================================================ 尾翼
  // 背鳍（垂尾根部与机身的填充）
  add(bodyRoot, loft([
    finSec(V(0, 2.20, -4.40), 3.40, 0.11),
    finSec(V(0, 3.40, -6.20), 3.00, 0.10),
    finSec(V(0, 4.60, -8.00), 2.60, 0.095),
    finSec(V(0, 5.60, -9.50), 2.20, 0.09),
  ]), matBody);
  // 垂尾：后掠 40°，顶 y=9.20（离地 12.0m），顶端圆角
  add(bodyRoot, loft([
    finSec(V(0, 1.50, -6.90), 6.00, 0.078),
    finSec(V(0, 3.60, -8.60), 5.20, 0.078),
    finSec(V(0, 5.70, -10.30), 4.20, 0.076),
    finSec(V(0, 7.40, -11.75), 3.10, 0.074),
    finSec(V(0, 8.50, -12.80), 2.20, 0.072),
    finSec(V(0, 9.05, -14.25), 1.30, 0.070),
    finSec(V(0, 9.20, -15.05), 0.60, 0.070),
  ]), matAccent);
  // 垂尾白色顶端带
  add(bodyRoot, loft([
    finSec(V(0, 7.90, -12.18), 2.65, 0.073),
    finSec(V(0, 8.50, -12.80), 2.20, 0.072),
    finSec(V(0, 9.05, -14.25), 1.30, 0.070),
    finSec(V(0, 9.20, -15.05), 0.60, 0.070),
  ]), matBody);
  // 平尾：展长 13.2m，后掠 32°。挂在尾锥上，位置要露在垂尾前方、
  // 机身外侧（否则侧视时整片机翼会埋进尾锥里看不见）。
  addPair(mir => loft([
    wingSec(0.00, 2.02, -10.60, 4.70, 0.095, 0, 0, mir),
    wingSec(2.60, 2.12, -11.62, 4.00, 0.090, 0, 0, mir),
    wingSec(5.20, 2.24, -13.05, 2.85, 0.085, 0, 0, mir),
    wingSec(6.60, 2.32, -14.20, 2.00, 0.080, 0, 0, mir),
  ]), matBody);
  addPair(mir => loft([
    wingSec(5.80, 2.29, -13.76, 2.10, 0.080, 0, 0, mir),
    wingSec(6.60, 2.32, -14.20, 2.00, 0.080, 0, 0, mir),
    wingSec(6.98, 2.38, -14.58, 1.25, 0.080, 0, 30, mir),
  ]), matAccent);
  // APU 排气口（机尾锥尖）
  const apu = new THREE.CylinderGeometry(0.28, 0.22, 0.60, 10);
  apu.rotateX(Math.PI / 2);
  add(bodyRoot, apu, matDuct, 0, 2.30, -18.80);

  // ============================================================ 发动机（翼下 2 台）
  // 用自建的 loft() 放样短舱（而不是 LatheGeometry）：loft 会按有向体积自动
  // 修正绕序，Lathe 的法线方向依赖轮廓点顺序，很容易整只渲染成黑色。
  /** 绕 Z 轴的回转体：[z, r] 轮廓 → 闭合壳体 */
  function revolve(profile, seg) {
    return loft(profile.map(p => {
      const pts = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        pts.push([Math.cos(a) * p[1], Math.sin(a) * p[1]]);
      }
      return { o: V(0, 0, p[0]), cd: V(1, 0, 0), td: V(0, 1, 0), pts };
    }));
  }
  // 短舱外型：前唇外翻成圆环、中段微鼓、尾部收细
  const nacGeo = revolve([
    [-2.25, 0.64], [-2.05, 0.76], [-1.70, 0.85], [-1.00, 0.91], [0.00, 0.94],
    [1.00, 0.95], [1.80, 0.95], [2.15, 0.94], [2.30, 0.89], [2.35, 0.82],
  ], 16);
  // 内涵道：从进气口向内延伸到风扇面
  const innerGeo = revolve([
    [-2.10, 0.55], [-1.00, 0.62], [0.30, 0.71], [1.30, 0.75], [2.14, 0.74],
  ], 16);
  const lipGeo = new THREE.TorusGeometry(0.835, 0.080, 5, 16);
  const nozGeo = new THREE.CylinderGeometry(0.56, 0.43, 0.90, 12, 1, true);
  nozGeo.rotateX(Math.PI / 2);
  const fanGeo = new THREE.CircleGeometry(0.75, 16);
  const hubGeo = new THREE.CylinderGeometry(0.14, 0.26, 0.62, 10);
  hubGeo.rotateX(Math.PI / 2);
  const spinGeo = new THREE.ConeGeometry(0.23, 0.70, 10);
  spinGeo.rotateX(Math.PI / 2);
  // 风扇叶片：12 片合成一个几何体（1 个 draw call，整体旋转）
  const fanBlades = (() => {
    const one = new THREE.BoxGeometry(0.52, 0.042, 0.24);
    one.translate(0.42, 0, 0);
    const parts = [];
    for (let i = 0; i < 12; i++) {
      const g = one.clone();
      g.rotateX(0.30);
      g.rotateZ((i / 12) * Math.PI * 2);
      parts.push(g);
    }
    return mergeGeos(parts);
  })();
  // 挂架：从短舱顶部斜向后上方延伸，接进机翼下表面
  const pylonGeo = loft([
    finSec(V(0, 1.28, 0.62), 5.00, 0.075),
    finSec(V(0, 0.90, 0.42), 4.20, 0.085),
    finSec(V(0, 0.45, 0.18), 3.30, 0.100),
  ]);

  const engines = [];
  for (const mir of [1, -1]) {
    const eg = new THREE.Group();
    eg.position.set(mir * ENG_X, ENG_Y, ENG_Z);
    bodyRoot.add(eg);
    add(eg, nacGeo, matEngine);
    add(eg, lipGeo, matBody, 0, 0, 2.28);                 // 白色进气唇口
    add(eg, innerGeo, matDuct);                           // 深色内涵道
    add(eg, nozGeo, matDuct, 0, 0, -2.55);                // 尾喷口
    add(eg, fanGeo, matDuct, 0, 0, 1.46);                 // 风扇盘
    add(eg, pylonGeo, matBody);
    const rotor = new THREE.Group();
    rotor.position.set(0, 0, 1.58);
    eg.add(rotor);
    add(rotor, fanBlades, matMetal);
    add(rotor, hubGeo, matMetal, 0, 0, 0.26);
    add(rotor, spinGeo, matMetal, 0, 0, 0.80);
    engines.push({ rotor, blades: [rotor] });
  }

  // ============================================================ 起落架
  // 轮底统一落在局部 y = -2.80（= PHYS.gearHeight）
  const gearDefs = [
    { pivot: V(0, -1.15, 12.30), len: 1.21, r: 0.44, w: 0.20, wheels: [[-0.28, 0], [0.28, 0]], rot: 'pitch' },
    { pivot: V(-3.40, -0.55, -2.60), len: 1.63, r: 0.62, w: 0.36, wheels: [[-0.42, 0], [0.42, 0]], rot: 'rollL' },
    { pivot: V(3.40, -0.55, -2.60), len: 1.63, r: 0.62, w: 0.36, wheels: [[-0.42, 0], [0.42, 0]], rot: 'rollR' },
  ];
  const gearLegs = [];
  for (const d of gearDefs) {
    const g = new THREE.Group();
    g.position.copy(d.pivot);
    bodyRoot.add(g);
    const leg = new THREE.Group();          // 仅支柱随受压缩放
    g.add(leg);
    add(leg, new THREE.CylinderGeometry(0.075, 0.105, d.len, 6), matHub, 0, -d.len / 2, 0);
    add(leg, new THREE.BoxGeometry(0.14, 0.42, 0.36), matHub, 0, -0.16, 0);   // 上部连接节
    add(leg, new THREE.CylinderGeometry(0.05, 0.05, d.len * 0.92, 5), matHub, 0, -d.len * 0.46, 0.32)
      .rotation.x = 0.40;                                                     // 斜撑
    for (const wz of d.wheels) {
      const tyre = add(g, new THREE.CylinderGeometry(d.r, d.r, d.w, 12), matTire,
        wz[0], -d.len, wz[1]);
      tyre.rotation.z = Math.PI / 2;                    // 轮轴沿 X（横着放）
      const hub = add(g, new THREE.CylinderGeometry(d.r * 0.46, d.r * 0.46, d.w + 0.03, 8), matHub,
        wz[0], -d.len, wz[1]);
      hub.rotation.z = Math.PI / 2;
    }
    gearLegs.push({ g, leg, len: d.len, rot: d.rot });
  }

  // ============================================================ 操纵面
  const slats = [];
  for (const mir of [1, -1]) {
    for (const s of [SLAT_IN, SLAT_OU]) {
      const p = midOf(s);
      const grp = new THREE.Group();
      grp.position.set(mir * p.x, p.y, p.z);
      bodyRoot.add(grp);
      add(grp, surfaceGeo(s, p, 0.10, mir), matAccent);
      slats.push(grp);
    }
  }
  const flaps = [];
  for (const mir of [1, -1]) {
    for (const s of [FLAP_IN, FLAP_OU]) {
      const p = midOf(s);
      const grp = new THREE.Group();
      grp.position.set(mir * p.x, p.y, p.z);
      bodyRoot.add(grp);
      add(grp, surfaceGeo(s, p, 0.09, mir), matAccent2);
      flaps.push(grp);
    }
  }
  const spoilers = [];
  for (const mir of [1, -1]) {
    for (const s of [SPOIL_A, SPOIL_B]) {
      const p = midOf(s);
      const grp = new THREE.Group();
      grp.position.set(mir * p.x, p.y, p.z);
      bodyRoot.add(grp);
      add(grp, surfaceGeo(s, p, 0.08, mir), matBody);
      spoilers.push(grp);
    }
  }
  // 副翼（外段后缘）
  for (const mir of [1, -1]) {
    const p = midOf(AILERON);
    const grp = new THREE.Group();
    grp.position.set(mir * p.x, p.y, p.z);
    bodyRoot.add(grp);
    add(grp, surfaceGeo(AILERON, p, 0.08, mir), matBody);
  }

  // ============================================================ 灯光
  const lampGeo = new THREE.SphereGeometry(0.24, 7, 5);
  add(bodyRoot, lampGeo, matNavL, -17.62, 2.98, -4.42);
  add(bodyRoot, lampGeo, matNavR, 17.62, 2.98, -4.42);
  add(bodyRoot, lampGeo, matNavT, 0, 2.32, -18.70);        // 尾锥航行灯
  add(bodyRoot, lampGeo, matNavT, 0, 9.24, -15.20);         // 垂尾顶灯
  const strobeGeo = new THREE.SphereGeometry(0.22, 7, 5);
  add(bodyRoot, strobeGeo, matStrobe, 0, 2.92, -1.20);      // 机背频闪
  add(bodyRoot, strobeGeo, matStrobe, 0, -1.72, 4.20);      // 机腹频闪
  add(bodyRoot, new THREE.SphereGeometry(0.20, 7, 5), matBeacon, 0, -1.80, 2.20);
  const landGeo = new THREE.CylinderGeometry(0.26, 0.30, 0.18, 10);
  landGeo.rotateX(Math.PI / 2);
  for (const s of [1, -1]) add(bodyRoot, landGeo, matLanding, s * 3.10, -0.92, 2.70);
  const warnGeo = new THREE.BoxGeometry(0.16, 0.34, 0.52);
  const warnA = add(bodyRoot, warnGeo, matWarn, -1.98, 1.55, -3.60);
  const warnB = add(bodyRoot, warnGeo, matWarn, 1.98, 1.55, -3.60);

  // ============================================================ 失速白烟
  const puffs = [];
  for (let i = 0; i < 11; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), matSmoke.clone());
    p.visible = false;
    p.renderOrder = 3;
    bodyRoot.add(p);
    puffs.push(p);
  }

  // ============================================================ 运行时状态
  let comp = 1;        // 起落架受压 0~1
  let gearIn = 0;      // 0=放下 1=收上
  let flapAng = 0;
  let slatOut = 0;
  let shake = 0;
  let warnOn = false;

  function setWarningLights(on) {
    warnOn = !!on;
    matWarn.emissiveIntensity = warnOn ? 3.4 : 0.0;
    warnA.visible = warnB.visible = warnOn;
  }

  function update(dt, elapsed, state) {
    const s = state || {};
    const d = clamp(dt, 0, 0.1);
    const speed = s.speed || 0;
    const throttle = clamp(s.throttle || 0, 0, 1);
    const alt = s.altitude !== undefined ? s.altitude : group.position.y;

    // 1) 风扇转速 0.6 + throttle*40 rad/s
    const spin = 0.6 + throttle * 40;
    for (const e of engines) e.rotor.rotation.z -= spin * d;

    // 2) 起落架：接地受压下沉 0.15m；离地 0.6s 缓动收放（不瞬移）
    comp += ((s.onGround ? 1 : 0) - comp) * ease(d, 0.16);
    gearIn += ((s.onGround ? 0 : 1) - gearIn) * ease(d, 0.16);
    bodyRoot.position.y = -0.15 * comp;
    for (const L of gearLegs) {
      L.leg.scale.y = Math.max(0.2, 1 - (0.15 * comp) / L.len);
      if (L.rot === 'pitch') L.g.rotation.x = -1.55 * gearIn;
      else if (L.rot === 'rollL') L.g.rotation.z = 1.62 * gearIn;
      else L.g.rotation.z = -1.62 * gearIn;
    }

    // 3) 襟翼：进近（高度<300 且速度<80）25°，起飞（速度>60）10°
    let flapTarget = 0;
    if (!s.onGround) {
      if (alt < 300 && speed < 80) flapTarget = 25 * DEG;
      else if (speed > 60) flapTarget = 10 * DEG;
    }
    flapAng += (flapTarget - flapAng) * ease(d, 0.5);
    for (const f of flaps) f.rotation.x = -flapAng;

    // 4) 缝翼：大速度 / 襟翼放出时前移下探
    const slatT = (!s.onGround && (speed > 55 || flapTarget > 0)) ? 1 : 0;
    slatOut += (slatT - slatOut) * ease(d, 0.4);
    for (const g of slats) { g.position.z = 0.34 * slatOut; g.position.y = -0.20 * slatOut; }

    // 5) 扰流器：spoiler ∈ [0,1] → 0~60°
    const sp = clamp(s.spoiler || 0, 0, 1);
    for (const g of spoilers) g.rotation.x = sp * 60 * DEG;

    // 6) 频闪灯周期 1.1s 亮 0.06s；红色信标反相慢闪
    const cyc = elapsed % 1.1;
    matStrobe.emissiveIntensity = cyc < 0.06 ? 7.0 : 0.0;
    matBeacon.emissiveIntensity = (cyc > 0.30 && cyc < 0.48) ? 4.0 : 0.0;

    // 7) 失速：机身左右抖动 ±2° + 断续白烟
    shake += ((s.stall ? 1 : 0) - shake) * ease(d, 0.10);
    bodyRoot.rotation.z = Math.sin(elapsed * 41.0) * 2 * DEG * shake;
    bodyRoot.rotation.x = Math.sin(elapsed * 33.0 + 1.1) * 1.0 * DEG * shake;
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i];
      if (shake < 0.03) { p.visible = false; continue; }
      p.visible = true;
      const t = (elapsed * 1.35 + i / puffs.length) % 1;
      const side = i % 2 ? 1 : -1;
      p.position.set(side * (5.4 + t * 4.0), -0.4 - t * 0.9 + Math.sin(t * 5 + i) * 0.7, -4.6 - t * 120);
      p.scale.setScalar(0.8 + t * 5.2);
      p.material.opacity = Math.sin(Math.PI * Math.min(t * 1.05, 1)) * 0.5 * shake;
      p.rotation.z = i * 0.7 + t * 2.0;
    }

    if (warnOn !== (!!s.warnLights || !!s.stall)) {
      setWarningLights(!!s.warnLights || !!s.stall);
    }
  }

  setWarningLights(false);

  return {
    group,
    update,
    collider: { radius: 4.2, center: new THREE.Vector3(0, -0.6, 0) },
    setWarningLights,
  };
}
