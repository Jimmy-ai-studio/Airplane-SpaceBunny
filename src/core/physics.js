/**
 * 飞行物理核心 —— 六自由度简化刚体模型。
 *
 * 设计要点：
 *  1. 姿态用「角速度一阶惯性逼近」实现：输入 → 目标角速度，实际角速度按时间常数 tau 追随。
 *     这保证飞机有真实的操纵惯性：不会瞬间转，也不会瞬间停。
 *  2. 升力/阻力/侧力在气流坐标系（稳定坐标系）计算，与角速度解耦 —— 高速时推杆有效。
 *  3. 地面与空中两套模型，用 onGround 标志切换，着陆瞬间记录全部接地参数。
 *  4. 固定子步长积分（1/200s），保证高刚度下的数值稳定。
 */
import * as THREE from '../../vendor/three.module.js';
import { PHYS, WORLD } from './constants.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 大坡度自动协调的起始坡度（rad，约 35°）
const BANK_COORD_RAD = 0.61;

/** 一阶惯性逼近：x 向 target 收敛，时间常数 tau */
function approach(x, target, tau, dt) {
  return x + (target - x) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));
}

export class FlightModel {
  constructor() {
    // 位置与速度
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();

    // 姿态角（弧度）
    this.pitch = 0;   // 抬头为正
    this.yaw = 0;
    this.roll = 0;

    // 实际角速度（rad/s）—— 惯性的载体
    this.pitchRate = 0;
    this.rollRate = 0;
    this.yawRate = 0;

    // 操纵输入
    this.inPitch = 0;   // -1 低头 .. +1 抬头
    this.inRoll = 0;
    this.inYaw = 0;
    this.throttle = 0;
    this._throttleAxis = 0;  // -1 收油 .. +1 加油
    this.brake = false;

    // 状态
    this.onGround = true;
    this.stall = false;
    this.gLoad = 1;
    this.alpha = 0;
    this.slip = 0;
    this.flap = 0;       // 0..1 襟翼放出量
    this.spoiler = 0;    // 0..1 扰流器
    this.accel = new THREE.Vector3();
    this.engineOut = false;
    this.justLiftedOff = false;
    this.wasOnGround = true;

    this._qTmp = new THREE.Quaternion();
    this._eTmp = new THREE.Euler(0, 0, 0, 'YXZ');
    this._vTmp = new THREE.Vector3();
    this._vTmp2 = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._force = new THREE.Vector3();
    this._airVel = new THREE.Vector3();
  }

  /** 重置到跑道待起飞状态（清除上一局全部状态） */
  reset() {
    // 起点必须在跑道足够靠前的位置：288 km/h 抬轮需约 830m 滑跑，
    // 起点 z=-1150 → 跑道端点 z=1500，可用滑跑距离 2650m，余量充足。
    this.pos.set(0, PHYS.gearHeight, -1150);
    this.vel.set(0, 0, 0);
    this.pitch = this.yaw = this.roll = 0;
    this.pitchRate = this.rollRate = this.yawRate = 0;
    this.inPitch = this.inRoll = this.inYaw = 0;
    this.throttle = 0;
    this._throttleAxis = 0;
    this.brake = false;
    this.onGround = true;
    this.wasOnGround = true;
    this.stall = false;
    this.gLoad = 1;
    this.alpha = this.slip = 0;
    this.flap = 0;
    this.spoiler = 0;
    this.engineOut = false;
    this.justLiftedOff = false;
    this.accel.set(0, 0, 0);
    this.syncQuat();
  }

  syncQuat() {
    // Three.js 约定：模型机头朝 +Z
    // 符号推导（右手系，绕 X 正转把 +Z 转向 -Y）：
    //   抬头(pitch>0) 需要 euler.x = -pitch
    //   航向(yaw>0 转向 +X) 需要 euler.y = -yaw
    //   右滚(roll>0, 右翼下沉) 需要 euler.z = +roll
    this._eTmp.set(-this.pitch, -this.yaw, this.roll, 'YXZ');
    this.quat.setFromEuler(this._eTmp);
  }

  get speed() { return this.vel.length(); }
  get altitudeAGL() { return this.pos.y - PHYS.gearHeight; }

  /** 航迹角：速度矢量相对水平面的仰角（rad，抬头为正） */
  get flightPathAngle() {
    const V = this.vel.length();
    if (V < 1) return 0;
    return Math.asin(clamp(this.vel.y / V, -1, 1));
  }

  get headingDeg() {
    let d = -this.yaw / DEG % 360;
    if (d < 0) d += 360;
    return d;
  }

  /** 每帧调用；terrainFn(x,z) 返回地面高度 */
  update(dt, terrainFn) {
    // 固定子步长积分
    const n = Math.max(1, Math.ceil(dt / PHYS.subStep));
    const h = dt / n;
    for (let i = 0; i < n; i++) this._step(h, terrainFn);
    this.syncQuat();
  }

  _step(dt, terrainFn) {
    this._updateControls(dt);
    this._integrateRotation(dt);
    this._integrateTranslation(dt, terrainFn);
  }

  // ---------- 操纵与油门 ----------
  _updateControls(dt) {
    const P = PHYS;
    this.throttle = clamp(this.throttle + this._throttleAxis * P.throttleRate * dt, 0, 1);
    // 空中按空格放扰流器，地面按空格刹车
    const spdF = this.speed;
    this.spoiler = approach(this.spoiler, this.brake && !this.onGround ? 1 : 0, 0.18, dt);

    // 襟翼逻辑（关键：起飞滑跑全程都在地面，不能用速度阈值判断）
    // 参照真实客机操作程序：
    //  - 地面：始终全放（起飞前襟翼必须保持，否则升力不足无法抬轮）
    //  - 起飞爬升：离地后保持全放，直到爬升完成（速度 > 190 m/s）
    //  - 巡航：收起减阻
    //  - 进近/着陆：高度低（< 500 m）且速度降低时再次放出
    let flapTarget;
    if (this.onGround) {
      flapTarget = 1;
    } else if (this.pos.y < 500 && spdF < 130) {
      flapTarget = 1;                       // 进近着陆
    } else {
      flapTarget = spdF < 190 ? 1 : 0;      // 起飞爬升 / 巡航
    }
    this.flap = approach(this.flap, flapTarget, 0.8, dt);
  }

  // ---------- 角速度一阶惯性 + 气动静稳定性 ----------
  // 操纵输入只提供「偏置力矩」；静稳定性提供把飞机拉回可飞姿态的恢复力矩。
  // 两者叠加后：松杆 → 飞机自动回到平飞配平（这是真实飞机能飞的前提）。
  _integrateRotation(dt) {
    const P = PHYS;
    if (this.onGround) {
      // 地面：偏航由方向舵/前轮转向，俯仰受尾撑限制，横滚被起落架强制归零
      const spd = Math.max(this.speed, 0.1);
      const authority = clamp(1.6 - spd / 120, 0.12, 1);
      const yawTarget = this.inYaw * P.maxSteerRate * authority;
      this.yawRate = approach(this.yawRate, yawTarget, P.groundYawTau, dt);

      const pitchTarget = clamp(this.inPitch, -1, 1) * P.maxGroundPitch;
      this.pitchRate = approach(this.pitchRate, (pitchTarget - this.pitch) * 2.2, 0.30, dt);

      this.rollRate = approach(this.rollRate, -this.roll * 6, 0.25, dt);
    } else {
      const q = 0.5 * P.rho * this.speed * this.speed;
      const authority = clamp(0.30 + q / 9000, 0.30, 1.0);

      // ---- 俯仰：操纵偏置 + 静稳定性配平 + α 保护 ----
      // 恒等式（已实测验证）：alpha ≈ pitch - gamma
      // 因此"把迎角拉回配平值"就等于"把 pitch 拉回 gamma + trimAlpha"，
      // 只需一个迎角反馈项即可，不要再叠加 gamma 项（否则两项符号相反 → 振荡）。
      const alphaNow = this.alpha;
      const alphaErr = P.trimAlpha - alphaNow;      // 迎角误差
      const stabPitch = clamp(alphaErr * P.pitchStability, -1, 1);
      // 俯仰阻尼：对 pitchRate 反馈，抑制长周期振荡（phugoid），这是真实飞机
      // 上由驾驶员/自动驾驶仪提供的气动+人工阻尼
      const damp = -this.pitchRate * P.pitchDamp;
      let cmd = this.inPitch + stabPitch + damp;

      // α 保护（对应真实空客 FBW 的迎角限制保护）：
      // 迎角超过保护阈值时，电脑直接覆盖操纵指令强制压杆，
      // 而不是"减去一点" —— 否则玩家持续拉杆仍会突破失速。
      const aAbs = Math.abs(alphaNow);
      if (aAbs > P.alphaProtect) {
        const over = (aAbs - P.alphaProtect) / Math.max(P.stallAngle - P.alphaProtect, 1e-3);
        // 迎角为正（气流从下方来、机头过高）→ 强制压杆；反之强制拉起
        const protectCmd = alphaNow > 0 ? -1 : 1;
        const w = Math.min(1, over * 2);
        cmd = cmd * (1 - w) + protectCmd * w;
      }

      // ---- 大坡度自动协调（对应真实客机的 FBW 协调功能）----
      // 压坡度不拉杆 → 升力垂直分量不足 → 持续掉高度。这是新手最常见的坠机原因。
      // 真实客机（A320 FBW）会在大坡度时自动协调拉杆，这里做等价简化：
      // 坡度越大，自动补偿的抬头量越大（要满足 L·cos(bank) ≥ W）。
      // 只叠加抬头量，不干预玩家的压坡度输入 —— 玩家仍可继续转，但不会掉高度。
      if (Math.abs(this.roll) > BANK_COORD_RAD) {
        const over = (Math.abs(this.roll) - BANK_COORD_RAD) / (0.78 - BANK_COORD_RAD);
        cmd += Math.min(1, over) * P.bankCoordGain;
      }

      const pitchTarget = clamp(cmd, -1, 1) * P.pitchRate * authority;
      this.pitchRate = approach(this.pitchRate, pitchTarget, P.pitchTau, dt);

      // ---- 横滚：操纵偏置 + 滚转阻尼 + 自动回平（防螺旋）----
      // 真实飞机的滚转角速度随坡度增大而下降（滚转阻尼随迎角/升力增加）。
      // 若不加此项，玩家持续按住方向键会在几秒内翻倒（实测可达 176°），
      // 既不真实也让游戏不可玩。这里让滚转权限在接近垂直时二次收敛，
      // 保证「持续满舵」也无法翻倒，最大坡度约 80°（真实客机极限约 60-70°）。
      const bankAbs = Math.abs(this.roll);
      const bankNorm = clamp(1 - bankAbs / 1.40, 0, 1);      // 1.40 rad ≈ 80°
      const rollAuth = P.rollRate * bankNorm * bankNorm * authority;
      const rollTarget = this.inRoll * rollAuth;
      this.rollRate = approach(this.rollRate, rollTarget, P.rollTau, dt);
      // 松杆时自动回平：向 roll=0 收敛（模拟飞行员/协调系统的自然修正）
      if (Math.abs(this.inRoll) < 0.05) {
        this.rollRate = approach(this.rollRate, -this.roll * P.rollLeveling, P.rollLevelTau, dt);
      }

      // ---- 偏航：方向舵 + 协调转弯 + 风标稳定 ----
      // 协调转弯：压坡度时机体会自然产生与坡度同向的偏航分量。
      // 符号：roll<0 表示右滚（机体右翼下沉），此时 yawRate 应为负，
      // 而 headingDeg = -yaw/DEG，故航向会增大 → 朝 +X 转 → 右转。正确。
      const coordYaw = Math.sin(this.roll) * 0.55;
      const yawTarget = (this.inYaw * P.yawRate + coordYaw * P.yawRate) * authority;
      this.yawRate = approach(this.yawRate, yawTarget, P.yawTau, dt);
    }

    this.pitch += this.pitchRate * dt;
    this.yaw += this.yawRate * dt;
    this.roll += this.rollRate * dt;

    if (this.pitch > Math.PI) this.pitch -= 2 * Math.PI;
    if (this.pitch < -Math.PI) this.pitch += 2 * Math.PI;
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
    if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
    this.roll = clamp(this.roll, -Math.PI * 0.98, Math.PI * 0.98);
  }

  // ---------- 力与运动积分 ----------
  _integrateTranslation(dt, terrainFn) {
    const P = PHYS;
    const q = this._qTmp.setFromEuler(this._eTmp.set(-this.pitch, -this.yaw, this.roll, 'YXZ'));

    // 机体轴（世界坐标）—— 全部复用向量，零分配
    const fwd = this._fwd.set(0, 0, 1).applyQuaternion(q);
    const up = this._up.set(0, 1, 0).applyQuaternion(q);
    const right = this._right.set(1, 0, 0).applyQuaternion(q);

    const av = this._airVel.copy(this.vel);
    const V = av.length();

    if (this.onGround) {
      this._groundMotion(dt, fwd, terrainFn);
      return;
    }

    // ---- 重力 ----
    const F = this._force.set(0, -P.g * P.mass, 0);

    // ---- 推力 ----
    if (!this.engineOut) {
      // 随高度衰减（等温近似）
      const densityRatio = Math.exp(-this.pos.y / 8500);
      F.addScaledVector(fwd, this.throttle * P.maxThrust * densityRatio);
    }

    if (V > 0.5) {
      const vdir = this._vTmp2.copy(av).divideScalar(V);

      // 气流坐标：把速度投影到机体轴
      const vf = av.dot(fwd);   // 前向
      const vs = av.dot(right); // 侧向
      const vu = av.dot(up);    // 垂向

      // 迎角 alpha：气流相对机体来流角。前向为正、垂向向下为正
      const alpha = Math.atan2(-vu, Math.max(vf, 0.1));
      this.alpha = alpha;
      // 侧滑角
      const slip = Math.atan2(-vs, Math.max(vf, 0.1));
      this.slip = slip;

      // ---- 升力系数（带失速衰减）----
      const aStall = Math.abs(alpha) > P.stallAngle;
      this.stall = aStall;
      let CL;
      if (!aStall) {
        CL = P.CL0 + P.CLalpha * alpha;
      } else {
        // 超过临界迎角：升力骤降（失速）
        const over = (Math.abs(alpha) - P.stallAngle) / P.stallAngle;
        const peak = P.CL0 + P.CLalpha * P.stallAngle * Math.sign(alpha);
        CL = peak * Math.max(0.35, 1 - over * 1.6);
      }
      CL += P.flapCL * this.flap;
      CL *= (1 - P.spoilerCLoss * this.spoiler);
      // 低速时升力平滑衰减到 0，避免地面附近抖动
      if (V < 12) CL *= V / 12;

      // ---- 过载限制（柔和截断）----
      let lift = 0.5 * P.rho * V * V * P.wingArea * CL;
      const maxLift = P.gLimit * P.g * P.mass;
      if (Math.abs(lift) > maxLift) lift = Math.sign(lift) * maxLift;
      this.gLoad = lift / (P.g * P.mass);

      // 升力方向：垂直于相对气流（在机体纵向平面内），简化取机体 up
      F.addScaledVector(up, lift);

      // ---- 阻力（二次 + 四次高速项 + 扰流器）----
      const vr = V / 100;
      const CD = P.CD0 + P.kInduced * CL * CL + P.cdHi * vr * vr + P.cdQuart * vr * vr * vr * vr
               + P.spoilerCD * this.spoiler;
      const drag = 0.5 * P.rho * V * V * P.wingArea * CD;
      F.addScaledVector(vdir, -drag);

      // ---- 侧力（侧滑阻尼）----
      // 符号约定：slip = atan2(-vs, vf)，其中 vs = 速度·right。
      // 当速度偏向机体右侧(vs>0) 时 slip<0，物理上应产生指向机体左侧(-right)的力来阻尼侧滑。
      // 因此 CY 必须取 +sideForceSlip * slip（此时 slip<0 → CY<0 → 力沿 -right），
      // 若写成负号会与侧向速度同向，等于持续向飞机注入能量 → 速度失控。
      const CY = P.sideForceSlip * slip;
      const sideF = 0.5 * P.rho * V * V * P.wingArea * CY;
      F.addScaledVector(right, sideF);
    } else {
      this.stall = false;
    }

    // ---- 积分 ----
    this.accel.copy(F).divideScalar(P.mass);
    this.vel.addScaledVector(this.accel, dt);
    this.pos.addScaledVector(this.vel, dt);
  }

  // ---------- 地面运动 ----------
  _groundMotion(dt, fwd, terrainFn) {
    const P = PHYS;
    const groundY = terrainFn(this.pos.x, this.pos.z);
    this.pos.y = groundY + P.gearHeight;
    if (this.vel.y < 0) this.vel.y = 0;

    // 速度分解为「沿机头」与「侧向」两部分
    let vFwd = this.vel.x * fwd.x + this.vel.z * fwd.z;
    let vLatX = this.vel.x - vFwd * fwd.x;
    let vLatZ = this.vel.z - vFwd * fwd.z;

    // 侧向摩擦极强（起落架抓地），侧滑在~0.06s 内被消掉
    vLatX *= Math.exp(-dt / 0.06);
    vLatZ *= Math.exp(-dt / 0.06);

    // ---- 推力（水平分量）----
    // 注意：推力必须在地面分支单独施加，否则飞机永远无法从静止起步
    if (!this.engineOut && this.throttle > 0) {
      const densityRatio = Math.exp(-this.pos.y / 8500);
      const thrustAccel = (this.throttle * P.maxThrust * densityRatio) / P.mass;
      vFwd += thrustAccel * dt;
    }

    // ---- 阻力：气动阻力（地面同样存在！）+ 滚动 + 刹车 ----
    // 关键：地面也必须计算气动阻力，否则全油门滑跑会无限加速到上千 km/h。
    const Vnow = Math.abs(vFwd);
    let decel = P.g * P.groundFriction + (this.brake ? P.brakeDecel : 0);
    if (Vnow > 0.5) {
      // 地面姿态近似水平，迎角≈0，仅计 parasite drag + 扰流器 + 襟翼阻力
      const vr = Vnow / 100;
      const CDg = P.CD0 + P.flapCD * this.flap + P.cdHi * vr * vr + P.cdQuart * vr * vr * vr * vr
                + P.spoilerCD * this.spoiler;
      const q = 0.5 * P.rho * Vnow * Vnow;
      decel += (q * P.wingArea * CDg) / P.mass;
    }
    if (vFwd > 0) vFwd = Math.max(0, vFwd - decel * dt);
    else if (vFwd < 0) vFwd = Math.min(0, vFwd + decel * dt);

    // 合成世界速度（地面垂直速度恒为 0）
    this.vel.set(vFwd * fwd.x + vLatX, 0, vFwd * fwd.z + vLatZ);

    // 位置推进
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // 地面俯仰回落到 0（尾撑支撑）
    if (this.inPitch < 0 || Math.abs(this.inPitch) < 0.01) {
      this.pitch = approach(this.pitch, 0, 0.5, dt);
    }

    // ---- 离地判定 ----
    // 严格用真实机体迎角（地面时机体前向即水平，迎角=抬头姿态角）计算升力。
    // 一旦升力超过重力，立即切换到空中积分，让俯仰/速度自然接管。
    // 关键：不能只靠"净垂直加速度>0"这种弱条件，否则会反复贴地弹跳。
    const V = this.vel.length();
    if (V > 1) {
      const alphaEst = this.pitch;          // 地面迎角 = 抬头姿态角
      let CL = P.CL0 + P.CLalpha * alphaEst + P.flapCL * this.flap;
      if (alphaEst > P.stallAngle) CL = (P.CL0 + P.CLalpha * P.stallAngle) * 0.5;
      if (V < 12) CL *= V / 12;
      const lift = 0.5 * P.rho * V * V * P.wingArea * CL;
      const netVy = (lift - P.g * P.mass) / P.mass;
      // 必须：① 明显抬头 ② 升力显著超过重力（留 15%裕度，避免临界抖动）
      if (netVy > 0.3 && this.pitch > 0.06) {
        this.onGround = false;
        this.justLiftedOff = true;
        // 给一个确定的初速脱离地面，避免下一帧又被"拉回"
        this.vel.y = Math.max(this.vel.y, 0.5);
        this.pos.y += PHYS.gearHeight * 0.02;
        this.pitchRate = Math.max(this.pitchRate, 0.05);
        return;
      }
    }
  }

  /**
   * 接地检查（由主循环每帧调用）。
   * 用「上一帧位置 → 当前位置」的线段扫掠来判定，而不只是比较当前高度：
   * 高速时单帧位移可达 1.3m 以上，严格比较会漏检（穿透地面）。
   * 返回接地信息或 null。
   */
  checkTouchdown(terrainFn, prevPos = null) {
    if (this.onGround) return null;
    const groundY = terrainFn(this.pos.x, this.pos.z);
    const curBottom = this.pos.y - PHYS.gearHeight;

    // 判断是否已穿过地面
    let crossed = curBottom <= groundY;
    // 扫掠检测：若上一帧在地面之上、这一帧在地面之下 → 也算接地
    if (!crossed && prevPos) {
      const prevBottom = prevPos.y - PHYS.gearHeight;
      const prevGround = terrainFn(prevPos.x, prevPos.z);
      if (prevBottom > prevGround && curBottom <= groundY) crossed = true;
    }
    if (!crossed) return null;

    const sink = -this.vel.y;      // 下沉率（正数越大越猛）
    const spd = Math.hypot(this.vel.x, this.vel.z);
    this.pos.y = groundY + PHYS.gearHeight;
    this.vel.y = 0;
    this.onGround = true;
    return {
      sink,
      speed: spd,
      bankDeg: Math.abs(this.roll) / DEG,
      pitchDeg: this.pitch / DEG,
      headingDeg: this.headingDeg,
      x: this.pos.x, z: this.pos.z,
    };
  }
}
