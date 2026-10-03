/**
 * 3 个有序空中检查点 —— 环平面法线 = 建议穿越方向。
 * 位置 / 半径严格取自 constants.CHECKPOINTS，本模块不重复定义数值。
 *
 * 判分采用「穿越平面法」+ 分段插值回溯，只检测当前 active 环，
 * 通过后立刻置 done，并用 CP_MIN_GAP 时间戳阻止重复刷分。
 */

import * as THREE from '../../vendor/three.module.js';
import { PALETTE, CHECKPOINTS, CP_MIN_GAP } from '../core/constants.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp;
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);

/** 数字牌用的 CanvasTexture（"1" / "2" / "3"），无外部字体文件 */
function numberTexture(n) {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');

  g.clearRect(0, 0, size, size);
  // 半透明圆角底板，保证任何背景下都可读
  g.fillStyle = 'rgba(12,18,26,0.55)';
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 5;
  const r = 16, pad = 10, w = size - pad * 2;
  g.beginPath();
  g.moveTo(pad + r, pad);
  g.arcTo(pad + w, pad, pad + w, pad + w, r);
  g.arcTo(pad + w, pad + w, pad, pad + w, r);
  g.arcTo(pad, pad + w, pad, r, r);
  g.arcTo(pad, pad, pad + w, r, r);
  g.closePath();
  g.fill();
  g.stroke();

  g.fillStyle = '#ffffff';
  g.font = 'bold 74px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), size / 2, size / 2 + 4);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createCheckpoints(scene) {
  const group = new THREE.Group();
  group.name = 'checkpoints';
  if (scene) scene.add(group);

  const list = CHECKPOINTS.map((cfg, i) => {
    const pos = new THREE.Vector3(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
    const normal = new THREE.Vector3(cfg.normal[0], cfg.normal[1], cfg.normal[2]).normalize();
    const R = cfg.radius;

    // 环的局部坐标：+Z 对齐 normal，用 quaternion 一次性摆正
    const holder = new THREE.Group();
    holder.position.copy(pos);
    holder.quaternion.setFromUnitVectors(V(0, 0, 1), normal);
    group.add(holder);

    const spin = new THREE.Group();       // 旋转只发生在面内
    holder.add(spin);

    const matRing = new THREE.MeshStandardMaterial({
      color: PALETTE.cpActive, roughness: 0.35, metalness: 0.25,
      emissive: PALETTE.cpActive, emissiveIntensity: 1.2,
      transparent: true, opacity: 0.95,
    });
    const matHalo = new THREE.MeshBasicMaterial({
      color: PALETTE.cpActive, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthWrite: false,
    });

    // 粗圆环（环内通透，不用实心盘）
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 3.6, 10, 40), matRing);
    spin.add(ring);
    // 外圈发光薄环
    const halo = new THREE.Mesh(new THREE.TorusGeometry(R + 7.5, 1.4, 6, 40), matHalo);
    spin.add(halo);

    // 4 个方向的支撑小柱（不随面内旋转也不影响通透性）
    const strutMat = new THREE.MeshStandardMaterial({
      color: PALETTE.aircraftDark, roughness: 0.7, metalness: 0.4,
      transparent: true, opacity: 0.9,
    });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const st = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 12), strutMat);
      st.position.set(Math.cos(a) * (R + 3.6), Math.sin(a) * (R + 3.6), 0);
      st.rotation.z = a;
      holder.add(st);
    }

    // 悬浮数字牌
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: numberTexture(cfg.id), transparent: true, depthTest: true, depthWrite: false,
    }));
    sprite.position.set(0, R + 26, 0);
    sprite.scale.set(26, 26, 1);
    holder.add(sprite);

    const entry = {
      id: cfg.id,
      index: i,
      pos,
      radius: R,
      normal,
      label: cfg.label,
      mesh: spin,
      holder,
      ring, halo, sprite, matRing, matHalo, strutMat,
      state: i === 0 ? 'active' : 'pending',
      passedAt: -Infinity,
      burstT: -1,          // done 爆发动画计时，<0 表示未触发
    };
    applyStateVisual(entry, entry.state);
    return entry;
  });

  /** 按状态刷新颜色 / 透明度 / 数字牌可见性 */
  function applyStateVisual(cp, state) {
    if (state === 'active') {
      cp.matRing.color.setHex(PALETTE.cpActive);
      cp.matRing.emissive.setHex(PALETTE.cpActive);
      cp.matHalo.color.setHex(PALETTE.cpActive);
      cp.sprite.material.opacity = 1.0;
      cp.strutMat.opacity = 0.9;
    } else if (state === 'done') {
      cp.matRing.color.setHex(PALETTE.cpDone);
      cp.matRing.emissive.setHex(PALETTE.cpDone);
      cp.matHalo.color.setHex(PALETTE.cpDone);
      cp.sprite.material.opacity = 0.35;
      cp.strutMat.opacity = 0.5;
    } else { // pending：暗淡半透明灰，几乎看不见
      cp.matRing.color.setHex(0x6b7280);
      cp.matRing.emissive.setHex(0x000000);
      cp.matHalo.color.setHex(0x6b7280);
      cp.sprite.material.opacity = 0.12;
      cp.strutMat.opacity = 0.18;
    }
  }

  function setState(i, state) {
    const cp = list[i];
    if (!cp) return;
    cp.state = state;
    if (state === 'done' && cp.burstT < 0) cp.burstT = 0;
    applyStateVisual(cp, state);
  }

  // ---------------------------------------------------------- 穿越判定
  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();

  /**
   * 检测飞机是否穿过当前 active 环。
   * @returns {null | {passedIndex:number, positions:THREE.Vector3[]}}
   */
  function check(prevPos, currPos, elapsed) {
    if (!prevPos || !currPos) return null;
    const positions = [];
    let passedIndex = -1;

    for (const cp of list) {
      if (cp.state !== 'active') continue;                 // a) 只检测 active
      if (elapsed - cp.passedAt < CP_MIN_GAP) continue;    // d) 最小间隔防刷分

      _n.copy(cp.normal);
      // b) 穿越平面法：两端分别投影，必须发生 负→正 的符号翻转
      const d0 = _p.subVectors(prevPos, cp.pos).dot(_n);
      const d1 = _p.subVectors(currPos, cp.pos).dot(_n);
      if (!(d0 < 0 && d1 >= 0)) continue;

      // 分段插值（最多 8 段）求出真正穿越点，防止单帧步长过大穿透漏检
      const STEPS = 8;
      let hit = null;
      let tPrev = 0, dPrev = d0;
      for (let s = 1; s <= STEPS; s++) {
        const t = s / STEPS;
        _p.lerpVectors(prevPos, currPos, t).sub(cp.pos);
        const dSeg = _p.dot(_n);
        if (dSeg >= 0) {
          // 段内再线性细化到精确落平面
          const f = dSeg - dPrev !== 0 ? -dPrev / (dSeg - dPrev) : 1;
          hit = new THREE.Vector3().lerpVectors(prevPos, currPos, tPrev + (t - tPrev) * f);
          break;
        }
        tPrev = t; dPrev = dSeg;
      }
      if (!hit) hit = currPos.clone();

      // c) 穿越点必须落在环半径内（留 2% 容差）
      const radial = hit.clone().sub(cp.pos);
      const along = radial.dot(_n);
      radial.addScaledVector(_n, -along);
      if (radial.length() > cp.radius * 0.98) continue;

      cp.passedAt = elapsed;                               // d) 打时间戳
      setState(cp.index, 'done');                          // d) 立刻置 done
      cp.burstT = 0;
      if (passedIndex < 0) passedIndex = cp.index;
      positions.push(hit);
    }

    if (positions.length === 0) return null;
    return { passedIndex, positions };
  }

  // ---------------------------------------------------------- 视觉更新
  function update(dt, elapsed) {
    for (const cp of list) {
      if (cp.state === 'active') {
        cp.mesh.rotation.z += dt * 0.9;                    // 持续旋转
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.0); // 呼吸发光
        cp.matRing.emissiveIntensity = 0.7 + pulse * 1.9;
        cp.matHalo.opacity = 0.22 + pulse * 0.26;
        const bob = 1 + pulse * 0.035;
        cp.mesh.scale.setScalar(bob);
      } else if (cp.state === 'pending') {
        cp.mesh.rotation.z += dt * 0.12;
        cp.matRing.emissiveIntensity = 0.06;
        cp.matHalo.opacity = 0.06;
        cp.mesh.scale.setScalar(1);
      } else { // done
        if (cp.burstT >= 0 && cp.burstT < 0.8) {
          cp.burstT += dt;                                  // 0.8s 内放大 1.6 倍 + 透明度降到 0.25
          const k = clamp(cp.burstT / 0.8, 0, 1);
          const e = 1 - Math.pow(1 - k, 2);                 // easeOutQuad
          cp.mesh.scale.setScalar(1 + 0.6 * e);
          cp.matRing.emissiveIntensity = 3.4 * (1 - e) + 0.55;
          cp.matHalo.opacity = 0.85 * (1 - e) + 0.18;
          cp.matRing.opacity = 0.95 - 0.70 * e;
          cp.mesh.rotation.z += dt * (5.0 * (1 - e) + 0.5);
        } else {
          cp.mesh.scale.setScalar(1);
          cp.matRing.emissiveIntensity = 0.42 + 0.16 * Math.sin(elapsed * 2.0);
          cp.matHalo.opacity = 0.14;
          cp.matRing.opacity = 0.25;
          cp.mesh.rotation.z += dt * 0.25;
        }
      }
    }
  }

  /** 全部通过：所有环同时爆发庆祝 */
  function celebrateAll() {
    for (const cp of list) {
      cp.state = 'done';
      cp.burstT = 0;
      cp.matRing.color.setHex(PALETTE.cpDone);
      cp.matRing.emissive.setHex(PALETTE.cpDone);
      cp.matHalo.color.setHex(PALETTE.cpDone);
      cp.sprite.material.opacity = 0.6;
    }
  }

  return { group, list, setState, check, update, celebrateAll };
}