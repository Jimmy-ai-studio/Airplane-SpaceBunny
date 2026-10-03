/**
 * 第三人称跟随相机 —— 弹簧阻尼跟随 + 速度感 FOV。
 * 关键：位置与视点分别用不同时间常数平滑，避免抖动；
 * 相机高度做地面抬升，防止穿地。
 */
import * as THREE from '../../vendor/three.module.js';
import { CAM } from '../core/constants.js';

export class ChaseCamera {
  constructor(camera, terrainFn) {
    this.camera = camera;
    this.terrainFn = terrainFn;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this.initialised = false;
  }

  reset() { this.initialised = false; }

  update(dt, model) {
    const q = model.quat;
    const fwd = this._fwd.set(0, 0, 1).applyQuaternion(q);
    const up = this._up.set(0, 1, 0).applyQuaternion(q);

    const speed = model.speed;
    // 速度感：后退距离随速度略微增加，FOV 随之扩大
    const spdN = Math.min(speed / 160, 1);
    const dist = CAM.dist + spdN * 8;
    const height = CAM.height + spdN * 2.2;

    // 期望机位：机后上方
    this._desired.copy(model.pos)
      .addScaledVector(fwd, -dist)
      .addScaledVector(up, height);

    // 相机不要沉到地面以下
    const gy = this.terrainFn(this._desired.x, this._desired.z);
    this._desired.y = Math.max(this._desired.y, gy + CAM.groundHeight);

    // 视点：机头前方 lookahead，转弯时带一点侧向提前量
    this._tmp.copy(model.pos)
      .addScaledVector(fwd, CAM.lookAhead)
      .addScaledVector(up, 2.5);

    if (!this.initialised) {
      this.pos.copy(this._desired);
      this.look.copy(this._tmp);
      this.initialised = true;
    } else {
      // 指数平滑（帧率无关）
      const kp = 1 - Math.exp(-dt / CAM.posTau);
      const kl = 1 - Math.exp(-dt / CAM.lookTau);
      this.pos.lerp(this._desired, kp);
      this.look.lerp(this._tmp, kl);
      // 相机硬性下限，防止任何情况穿地
      const cy = this.terrainFn(this.pos.x, this.pos.z) + 1.6;
      if (this.pos.y < cy) this.pos.y = cy;
    }

    this.camera.position.copy(this.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);

    // FOV 平滑
    const fov = CAM.fovBase + (CAM.fovMax - CAM.fovBase) * spdN;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt / 0.5));
      this.camera.updateProjectionMatrix();
    }
  }
}
