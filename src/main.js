/**
 * 主循环 —— 状态机 / 碰撞 / 检查点顺序 / 胜负判定 / 结果数据。
 *
 * 胜负规则：
 *   成功：依次通过 3 个检查点 + 在跑道内安全着陆并停稳
 *   失败：撞地、撞建筑、失速坠毁、重着陆、接地姿态/速度超限、落在跑道外、冲出跑道、飞出空域、超时
 *   任何结局都可按 R 立即重开，且重开会清空全部本局状态。
 */
import * as THREE from '../vendor/three.module.js';
import { WORLD, PHYS, PHASE, FAIL_REASON, CHECKPOINTS, CP_MIN_GAP } from './core/constants.js';
import { FlightModel } from './core/physics.js';
import { Input } from './systems/input.js';
import { ChaseCamera } from './systems/chase-camera.js';
import { createEnvironment, terrainHeight } from './world/environment.js';
import { createAircraft } from './world/craft.js';
import { createCheckpoints } from './world/checkpoints.js';
import { createHUD } from './ui/hud.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

class Game {
  constructor() {
    this.canvas = document.getElementById('scene');
    this._initRenderer();
    this._initScene();

    // 场景与实体
    this.env = createEnvironment(this.scene);
    this.craft = createAircraft();
    this.scene.add(this.craft.group);
    this.cps = createCheckpoints(this.scene);

    // 物理与控制
    this.model = new FlightModel();
    this.input = new Input(window);
    this.chase = new ChaseCamera(this.camera, terrainHeight);

    // HUD
    this.hud = createHUD();
    this.hud.onStart(() => this.start());
    this.hud.onRestart(() => this.restart());
    this.hud.onMenu(() => this.toMenu());

    this._bindGlobalKeys();

    // 运行状态
    this.phase = PHASE.MENU;
    this.timer = 0;
    this.cpIndex = 0;          // 下一个待通过的检查点下标
    this.cpRecords = [];       // 已通过记录
    this.cpPassedAt = new Array(CHECKPOINTS.length).fill(-Infinity);
    this.landingInfo = null;
    this.failReason = null;
    this.takeoffTime = null;
    this._prevPos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._elapsed = 0;
    this._lastT = performance.now();
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.fps = 60;

    this.reset();
    this.hud.hideLoading();
    this.hud.showMenu();

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ---------------- 初始化 ----------------
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    addEventListener('resize', () => {
      this.renderer.setSize(innerWidth, innerHeight);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.5, 40000);
  }

  _bindGlobalKeys() {
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyR') { this.restart(); }
      else if (e.code === 'Escape') { this.toMenu(); }
      else if (e.code === 'KeyH' || e.code === 'Slash') { this.hud.toggleHelp?.(); }
    });
  }

  // ---------------- 局控制 ----------------
  reset() {
    this.model.reset();
    this.input.clear();
    this.chase.reset();
    this.timer = 0;
    this.cpIndex = 0;
    this.cpRecords = [];
    this.cpPassedAt.fill(-Infinity);
    this.landingInfo = null;
    this.failReason = null;
    this.takeoffTime = null;
    this._prevPos.copy(this.model.pos);
    // 检查点全部重置为 pending，0 号 active
    this.cps.list.forEach((c, i) => this.cps.setState(i, i === 0 ? 'active' : 'pending'));
    this._syncCraftTransform();
  }

  start() {
    this.reset();
    this.phase = PHASE.READY;
    this.hud.hideMenu();
    this.hud.hideResult();
    this.hud.setPhase(this.phase);
    this.hud.toast('推油门到最大，速度到 250 km/h 以上轻轻拉杆抬轮', 4200);
  }

  restart() {
    this.start();
  }

  toMenu() {
    this.phase = PHASE.MENU;
    this.reset();
    this.hud.hideResult();
    this.hud.showMenu();
  }

  // ---------------- 胜负判定 ----------------
  _fail(reason) {
    if (this.phase === PHASE.FAILED || this.phase === PHASE.SUCCESS) return;
    this.failReason = reason;
    this.phase = PHASE.FAILED;
    this.hud.setPhase(this.phase);
    this.hud.flashFail();
    this.hud.setWarning(FAIL_REASON[reason] || reason);
    this.hud.showResult(this._buildResult(false, reason));
  }

  _succeed() {
    this.phase = PHASE.SUCCESS;
    this.hud.setPhase(this.phase);
    this.hud.flashSuccess();
    this.hud.setWarning(null);
    this.cps.celebrateAll();
    this.hud.showResult(this._buildResult(true, null));
  }

  _buildResult(success, reason) {
    const L = this.landingInfo;
    return {
      success,
      reason,
      timeSec: this.timer,
      totalSec: PHYS.timeLimit,
      checkpoints: this.cpRecords.map((r) => ({
        id: r.id, timeSec: r.timeSec, passed: true,
      })),
      landing: L ? {
        sinkRate: L.sink, speed: L.speed, ok: L.ok, note: L.note,
      } : null,
      tips: this._tips(success, reason, L),
    };
  }

  _tips(success, reason, L) {
    const tips = [];
    if (success) {
      tips.push('太棒了！整套流程干净利落。');
      if (L && L.sink > 0.6) tips.push(`接地下沉率 ${L.sink.toFixed(2)} m/s 略大，保持轻微拉杆可以让接地更柔和。`);
      if (L && L.speed > PHYS.goodLandingSpeed) tips.push(`接地速度 ${(L.speed * 3.6).toFixed(0)} km/h 偏高，进近阶段用「空格」扰流器配合收油能减得更快。`);
      if (!L || L.sink < 0.5) tips.push('接地非常轻柔，保持这个手感。');
      tips.push('想进一步提速，可以把第 2、3 个检查点穿得更靠中心，减少修正动作。');
    } else {
      if (reason === FAIL_REASON.CRASH_GROUND || reason === FAIL_REASON.STALL) {
        tips.push('爬升时不要一直猛拉杆：速度掉到失速迎角就会掉高度。先保持速度，再平稳增加俯仰。');
      }
      if (reason === FAIL_REASON.HARD_LANDING) {
        tips.push('接地前 10 秒把下沉率压到 1 m/s 以内：轻轻带杆、别让飞机掉下去。');
      }
      if (reason === FAIL_REASON.TOO_FAST) {
        tips.push(`接地速度超过 ${(PHYS.touchdownMaxSpeed * 3.6).toFixed(0)} km/h 会判失败。进近时把油门收到 20% 以下，用「空格」减速。`);
      }
      if (reason === FAIL_REASON.OFF_RUNWAY) {
        tips.push('必须在跑道中心线 ±30 m 内接地。先用「A/D」把机头对准跑道中线，再下降。');
      }
      if (reason === FAIL_REASON.CRASH_BUILDING) {
        tips.push('注意航站楼和塔台。转弯时先压坡度再收油门，别贴着建筑飞。');
      }
      if (this.cpIndex < CHECKPOINTS.length) {
        tips.push(`还有 ${CHECKPOINTS.length - this.cpIndex} 个检查点没过。检查点必须按 1 → 2 → 3 顺序穿，只算当前高亮的那一个。`);
      }
    }
    return tips;
  }

  /** 碰撞检测：跑道外地面 / 建筑物 AABB */
  _checkCollision() {
    const m = this.model;
    const P = this.phase;

    // 飞出空域
    if (Math.abs(m.pos.x) > WORLD.boundX ||
        m.pos.z < WORLD.boundZMin || m.pos.z > WORLD.boundZMax) {
      return FAIL_REASON.BOUNDARY;
    }
    if (m.pos.y > WORLD.ceiling) {
      return FAIL_REASON.CEILING;
    }

    // 建筑物碰撞（AABB，用飞机碰撞球心 + 半径）
    const c = this.craft.collider;
    const cx = m.pos.x + c.center.x, cy = m.pos.y + c.center.y, cz = m.pos.z + c.center.z;
    for (const b of this.env.colliders) {
      if (cx + c.radius > b.minX && cx - c.radius < b.maxX &&
          cy + c.radius > b.minY && cy - c.radius < b.maxY &&
          cz + c.radius > b.minZ && cz - c.radius < b.maxZ) {
        return FAIL_REASON.CRASH_BUILDING;
      }
    }

    // 撞地：不在跑道范围内且低于地面
    const onRunwayX = Math.abs(m.pos.x) <= WORLD.runwayWidth / 2 + 5;
    const onRunwayZ = m.pos.z >= -WORLD.runwayLength / 2 - PHYS.runwayPadZ &&
                      m.pos.z <= WORLD.runwayLength / 2 + PHYS.runwayPadZ;
    const groundY = terrainHeight(m.pos.x, m.pos.z);
    if (!m.onGround && m.pos.y - PHYS.gearHeight <= groundY + 0.05) {
      if (onRunwayX && onRunwayZ) return null; // 由 checkTouchdown 处理（合法着陆流程）
      // 撞地/落在跑道外
      return m.vel.y < -3 ? FAIL_REASON.CRASH_GROUND : FAIL_REASON.OFF_RUNWAY;
    }
    return null;
  }

  /** 着陆判定（在 checkTouchdown 之后调用） */
  _judgeLanding(td) {
    const P = PHYS;
    const onRunwayX = Math.abs(td.x) <= this.env.runway.halfWidth + 3;
    const onRunwayZ = td.z >= this.env.runway.minZ && td.z <= this.env.runway.maxZ;

    let ok = true;
    let note = '接地平稳';
    let reason = null;

    // 判定顺序很重要：先区分「坠毁」与「落在跑道外」，再看姿态/速度。
    // 高速大下沉率接地 = 坠毁（CRASH_GROUND），而不是「落在跑道外」。
    if (td.sink > 3.0) {
      ok = false; reason = FAIL_REASON.CRASH_GROUND;
      note = `以 ${td.sink.toFixed(1)} m/s 的下沉率砸向地面`;
    } else if (!onRunwayX) {
      ok = false; reason = FAIL_REASON.OFF_RUNWAY; note = '落在跑道中线外';
    } else if (!onRunwayZ) {
      ok = false; reason = FAIL_REASON.OFF_RUNWAY; note = '落在跑道范围外';
    } else if (td.sink > P.touchdownMaxSink) {
      ok = false; reason = FAIL_REASON.HARD_LANDING; note = `下沉率 ${td.sink.toFixed(2)} m/s`;
    } else if (td.speed > P.touchdownMaxSpeed) {
      ok = false; reason = FAIL_REASON.TOO_FAST; note = `接地速度 ${(td.speed * 3.6).toFixed(0)} km/h`;
    } else if (td.bankDeg > P.touchdownMaxBankDeg) {
      ok = false; reason = FAIL_REASON.BAD_ATTITUDE; note = `坡度 ${td.bankDeg.toFixed(0)}°`;
    } else if (Math.abs(td.pitchDeg) > P.touchdownMaxPitchDeg) {
      ok = false; reason = FAIL_REASON.BAD_ATTITUDE; note = `俯仰 ${td.pitchDeg.toFixed(0)}°`;
    }

    this.landingInfo = { ...td, ok, note };
    if (!ok) { this._fail(reason); return; }

    this.phase = PHASE.LANDED;
    this.hud.setPhase(this.phase);
    const grade = td.sink < 0.5 && td.speed < P.goodLandingSpeed ? '优秀着陆 🌟' : '着陆成功 ✅';
    this.hud.toast(`${grade}　接地速度 ${(td.speed * 3.6).toFixed(0)} km/h，下沉率 ${td.sink.toFixed(2)} m/s`, 4200);
  }

  /** 检查点滑行停止 → 成功 */
  _checkStop() {
    if (this.phase !== PHASE.LANDED) return;
    if (this.model.speed < PHYS.stopSpeed) {
      const allCp = this.cpIndex >= CHECKPOINTS.length;
      if (allCp) this._succeed();
      else this._fail(FAIL_REASON.CRASH_GROUND);
    }
  }

  // ---------------- 每帧 ----------------
  _loop(now) {
    requestAnimationFrame(this._loop);
    let dt = (now - this._lastT) / 1000;
    this._lastT = now;
    if (dt > 0.1) dt = 0.1;      // 防止切后台后大跳
    this._elapsed += dt;

    // FPS 统计
    this._fpsAccum += dt; this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0; this._fpsFrames = 0;
    }

    if (this.phase === PHASE.MENU) {
      // 菜单：飞机静置，仅相机环绕待机
      this._updateMenuIdle(dt);
    } else {
      this._updateFlight(dt);
    }

    this.env.update(dt, this._elapsed, this.model.pos);
    this.cps.update(dt, this._elapsed);
    this.renderer.render(this.scene, this.camera);
  }

  _updateMenuIdle(dt) {
    this._syncCraftTransform();
    this.chase.update(dt, this.model);
    this.cps.update(0, this._elapsed);
    this.craft.update(dt, this._elapsed, {
      pitch: 0, yaw: 0, roll: 0, speed: 0, throttle: 0,
      sinkRate: 0, onGround: true, stall: false, spoiler: 0,
    });
    this._updateHud(dt);
  }

  _updateFlight(dt) {
    const m = this.model;
    // 胜负已分 → 冻结物理，只保留相机与视觉（避免失败后飞机继续失控飞行）
    if (this.phase === PHASE.SUCCESS || this.phase === PHASE.FAILED) {
      this._syncCraftTransform();
      this.chase.update(dt, m);
      this.craft.update(dt, this._elapsed, {
        pitch: m.pitch, yaw: m.yaw, roll: m.roll, speed: m.speed,
        throttle: m.throttle, sinkRate: m.vel.y, onGround: m.onGround,
        stall: m.stall, spoiler: m.spoiler,
      });
      this._updateHud(dt);
      return;
    }
    const flying = this.phase === PHASE.READY || this.phase === PHASE.FLYING ||
                   this.phase === PHASE.LANDED;

    if (flying) {
      // ---- 输入 → 模型 ----
      const a = this.input.axes;
      m.inPitch = a.pitch;
      m.inRoll = a.roll;
      m.inYaw = a.yaw;
      m.brake = a.brake;
      m._throttleAxis = a.throttleAxis;

      this._prevPos.copy(m.pos);
      m.update(dt, terrainHeight);

      // 离地 → 进入 FLYING，开始计时
      if (this.phase === PHASE.READY && !m.onGround) {
        this.phase = PHASE.FLYING;
        this.hud.setPhase(this.phase);
        this.takeoffTime = this.timer;
      }
      if (this.phase === PHASE.FLYING || this.phase === PHASE.READY || this.phase === PHASE.LANDED) {
        this.timer += dt;
      }

      // ---- 接地判定（传 prevPos 做扫掠检测，避免高速穿透漏检）----
      const td = m.checkTouchdown(terrainHeight, this._prevPos);
      if (td) {
        if (this.timer > 1.0) {
          // 关键：必须对「跑道内/外」分别判定。
          // 若不在跑道内，checkTouchdown 已把飞机置为 onGround，
          // 此后 _checkCollision 里的 !onGround 分支不会再触发 → 撞地/落跑道外会漏判。
          this._judgeLanding(td);
        } else {
          m.onGround = true;
        }
      }

      // ---- 若接地判定已分出胜负，立即结束本帧 ----
      // 否则会在已判定失败后继续跑碰撞/检查点/超时逻辑，造成状态错乱
      if (this.phase === PHASE.FAILED || this.phase === PHASE.SUCCESS) {
        this._syncCraftTransform();
        this.chase.update(dt, m);
        this.craft.update(dt, this._elapsed, {
          pitch: m.pitch, yaw: m.yaw, roll: m.roll, speed: m.speed,
          throttle: m.throttle, sinkRate: m.vel.y, onGround: m.onGround,
          stall: m.stall, spoiler: m.spoiler,
        });
        this._updateHud(dt);
        return;
      }

      // ---- 碰撞（仅在空中判定）----
      if (!m.onGround) {
        const cr = this._checkCollision();
        if (cr) this._fail(cr);
      }
      if (this.phase === PHASE.FAILED) return;

      // ---- 检查点（仅在空中）----
      if (!m.onGround && this.cpIndex < CHECKPOINTS.length) {
        const r = this.cps.check(this._prevPos, m.pos, this._elapsed);
        if (r && r.passedIndex === this.cpIndex && this._elapsed - this.cpPassedAt[this.cpIndex] >= CP_MIN_GAP) {
          this.cpPassedAt[this.cpIndex] = this._elapsed;
          const cp = CHECKPOINTS[this.cpIndex];
          this.cpRecords.push({
            id: cp.id,
            timeSec: this.takeoffTime != null ? this._elapsed - this.takeoffTime : this._elapsed,
          });
          this.cpIndex++;
          // 切换下一个为 active
          if (this.cpIndex < CHECKPOINTS.length) this.cps.setState(this.cpIndex, 'active');
          this.cps.setState(this.cpIndex - 1, 'done');

          if (this.cpIndex >= CHECKPOINTS.length) {
            this.hud.toast('三个检查点全部通过！现在返场着陆 🛬', 4600);
            this.hud.setWarning('返场着陆：把机头对准跑道中线');
          } else {
            const nxt = CHECKPOINTS[this.cpIndex];
            this.hud.toast(`检查点 ${this.cpIndex} / 3 通过`, 2200);
            this.hud.setWarning(`下一个：检查点 ${nxt.id}（${nxt.label}）`);
          }
        }
      }

      // ---- 超时 ----
      if (this.timer > PHYS.timeLimit) this._fail(FAIL_REASON.TIMEOUT);

      // ---- 地面停稳判定 ----
      this._checkStop();

      // ---- 警告提示 ----
      this._updateWarnings();
    }

    // ---- 视觉同步 ----
    this._syncCraftTransform();
    this.chase.update(dt, m);
    this.craft.update(dt, this._elapsed, {
      pitch: m.pitch, yaw: m.yaw, roll: m.roll, speed: m.speed,
      throttle: m.throttle, sinkRate: m.vel.y, onGround: m.onGround,
      stall: m.stall, spoiler: m.spoiler,
    });
    this._updateHud(dt);
  }

  _syncCraftTransform() {
    const g = this.craft.group;
    g.position.copy(this.model.pos);
    g.quaternion.copy(this.model.quat);
  }

  _updateWarnings() {
    const m = this.model;
    const P = PHYS;
    const bankDeg = Math.abs(m.roll) / DEG;

    if (m.speed > P.vne) {
      this.hud.setStall(false);
      this.hud.setWarning(`超速！${(m.speed * 3.6).toFixed(0)} km/h 已超过结构限制，立即减速！`);
      return;
    }
    if (m.stall) {
      this.hud.setStall(true);
      this.hud.setWarning('失速！立即低头加油门');
      return;
    }
    this.hud.setStall(false);

    // 大坡度警告：真实飞机压坡度不拉杆就会掉高度。
    // 新手最常见的坠机原因就是「压了坡度忘记补拉杆」，必须给出明确提示。
    if (bankDeg > 32 && !m.onGround) {
      const lose = (1 - Math.cos(m.roll)) * 100;
      this.hud.setWarning(`大坡度 ${bankDeg.toFixed(0)}°！升力损失 ${lose.toFixed(0)}%，按 ↑ 拉杆补偿否则掉高度`);
      return;
    }

    // 无警告时保留航路提示
    if (this.phase === PHASE.FLYING) {
      if (this.cpIndex < CHECKPOINTS.length) {
        const nxt = CHECKPOINTS[this.cpIndex];
        this.hud.setWarning(`下一个：检查点 ${nxt.id}（${nxt.label}）`);
      } else {
        this.hud.setWarning('返场着陆：把机头对准跑道中线');
      }
    } else if (this.phase === PHASE.READY) {
      this.hud.setWarning('按住 W 加油门至最大，速度到 250 km/h 以上按 ↑ 抬轮');
    }
  }

  _updateHud(dt) {
    const m = this.model;
    this.hud.setTimer(this.timer);
    this.hud.setPhase(this.phase);
    this.hud.setFlight({
      // HUD 的速度标签单位是 km/h，物理模型内部是 m/s，这里做换算
      speed: m.speed * 3.6,
      altitude: Math.max(0, m.pos.y - WORLD.runwayY),
      vs: m.vel.y,
      throttle: m.throttle,
      heading: m.headingDeg,
      pitch: m.pitch / DEG,
      roll: m.roll / DEG,
      onGround: m.onGround,
      stall: m.stall,
      spoiler: m.spoiler,
    });
    this.hud.setCheckpoints(
      this.cps.list.map((c) => c.state),
      this.cpIndex
    );
    this.hud.drawAttitude(m.pitch / DEG, -m.roll / DEG, m.headingDeg);
  }
}

// 启动
window.addEventListener('DOMContentLoaded', () => {
  try {
    window.__game = new Game();
  } catch (err) {
    console.error(err);
    const l = document.getElementById('loading');
    if (l) l.innerHTML = `<div style="color:#ff8080;padding:20px">初始化失败：${err.message}</div>`;
  }
});
