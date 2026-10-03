/**
 * 无头物理台架 —— 不依赖浏览器，直接跑 FlightModel 验证飞行品质。
 * 用法: node tools/physics-bench.mjs
 * 模拟平坦地面（机场区域地形为 0）。
 */
import { PHYS, WORLD } from '../src/core/constants.js';
import { FlightModel } from '../src/core/physics.js';

const DEG = Math.PI / 180;
const flat = () => 0;
const kmh = (v) => (v * 3.6).toFixed(0);
const START_Z = -1150;

function makeM() {
  const m = new FlightModel();
  m.reset();
  return m;
}

/** 模拟 seconds 秒，每步 dt，ctrl(t, m) 可注入控制 */
function sim(m, seconds, dt, ctrl) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    if (ctrl) ctrl(i * dt, m);
    m.update(dt, flat);
    if (m.justLiftedOff) m.justLiftedOff = false;
  }
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(40)} ${detail}`);
}

// ================= 1. 起飞滑跑 =================
{
  const m = makeM();
  let reached = null;
  sim(m, 40, 1 / 60, (t, mm) => {
    mm._throttleAxis = 1; mm.inPitch = 0;
    if (!reached && mm.speed > 80) reached = { t, z: mm.pos.z };
  });
  const usable = WORLD.runwayLength / 2 - START_Z;
  const roll = reached ? reached.z - START_Z : Infinity;
  check('全油门滑跑达起飞速度且不冲出跑道',
    reached !== null && roll < usable - 300,
    reached ? `V=288km/h 用时 ${reached.t.toFixed(1)}s, 滑跑 ${roll.toFixed(0)}m (可用 ${usable.toFixed(0)}m, 余量 ${(usable - roll).toFixed(0)}m)` : '40s 未达 80 m/s');

  const m2 = makeM();
  sim(m2, 150, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = 0; });
  check('地面极速在 400~650 km/h（气动阻力生效）',
    m2.speed * 3.6 > 400 && m2.speed * 3.6 < 650, `地面终端 ${(m2.speed * 3.6).toFixed(0)} km/h`);
}

// ================= 2. 不能原地瞬起 =================
{
  const m = makeM();
  sim(m, 60, 1 / 60, (t, mm) => { mm._throttleAxis = 1; });
  const vBefore = m.speed;
  let liftTime = null;
  sim(m, 3, 1 / 60, (t, mm) => {
    mm._throttleAxis = 1; mm.inPitch = 1;
    if (!m.onGround && liftTime === null) liftTime = t;
  });
  check('抬轮有延迟（不能原地瞬起）', liftTime !== null && liftTime > 0.15,
    liftTime === null ? '3s 内未离地' : `拉杆后 ${liftTime.toFixed(2)}s 离地 (离地速度 ${kmh(vBefore)} km/h)`);

  // 静止状态猛拉杆，5 秒内不应离地
  const s = makeM();
  sim(s, 5, 1 / 60, (t, mm) => { mm._throttleAxis = 0; mm.inPitch = 1; mm.brake = true; });
  check('静止时拉杆不会起飞', s.onGround === true,
    `静止满杆 5s: onGround=${s.onGround}, 速度 ${kmh(s.speed)} km/h`);
}

// ================= 3. 爬升与α 保护 =================
{
  const m = makeM();
  sim(m, 45, 1 / 60, () => { m._throttleAxis = 1; });
  const a0 = m.pos.y;
  sim(m, 20, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = 0.3; });
  check('全油门稳定爬升（20s > 400m）', m.pos.y - a0 > 400,
    `净爬升 ${(m.pos.y - a0).toFixed(0)}m, 爬升率 ${m.vel.y.toFixed(1)} m/s, V=${kmh(m.speed)} km/h`);
  check('适量拉杆爬升中不失速', m.stall === false,
    `stall=${m.stall}, alpha=${(m.alpha / DEG).toFixed(1)}°, V=${kmh(m.speed)} km/h`);

  // 持续满杆 → α 保护应阻止永久失速（真实客机 FBW 行为）
  sim(m, 20, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = 1; });
  check('持续满杆时α 保护阻止坠毁', m.stall === false && m.pos.y > 0,
    `20s 满杆: stall=${m.stall}, alpha=${(m.alpha / DEG).toFixed(1)}°, 高度 ${m.pos.y.toFixed(0)}m, V=${kmh(m.speed)} km/h`);

  // 松杆应能恢复（退出保护）
  sim(m, 25, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = -0.3; });
  check('松杆低头可脱离失速', m.stall === false,
    `低头 25s: stall=${m.stall}, alpha=${(m.alpha / DEG).toFixed(1)}°, 高度 ${m.pos.y.toFixed(0)}m`);
}

// ================= 4. 巡航与配平 =================
{
  const m = makeM();
  sim(m, 40, 1 / 60, () => { m._throttleAxis = 1; });
  sim(m, 20, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = t < 3 ? 0.6 : 0.05; });
  const y0 = m.pos.y;
  sim(m, 60, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = 0; });
  check('全油门巡航 250~750 km/h', m.speed * 3.6 > 250 && m.speed * 3.6 < 750,
    `V=${kmh(m.speed)} km/h`);
  check('松杆后能大致保持高度（|dy|<400m）', Math.abs(m.pos.y - y0) < 400,
    `60s 高度变化 ${(m.pos.y - y0).toFixed(0)}m`);
}

// ================= 5. 空中刹车 =================
// 从稳定巡航状态开始测（爬升段能量不足会干扰结果）
function toCruise() {
  const m = makeM();
  sim(m, 40, 1 / 60, () => { m._throttleAxis = 1; });
  sim(m, 12, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = t < 3 ? 0.6 : 0; });
  sim(m, 25, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = 0; });
  return m;
}
{
  const m = toCruise();
  const v0 = m.speed;
  sim(m, 0.3, 1 / 60, (t, mm) => { mm._throttleAxis = 0; mm.brake = true; });
  check('空中刹车 0.3s 不会把飞机停住', m.speed > v0 * 0.75,
    `V: ${kmh(v0)} → ${kmh(m.speed)} km/h (保留 ${(m.speed / v0 * 100).toFixed(0)}%)`);
  sim(m, 10, 1 / 60, (t, mm) => { mm._throttleAxis = 0; mm.brake = true; });
  check('空中刹车 10s 显著减速', m.speed < v0 * 0.95,
    `V: ${kmh(v0)} → ${kmh(m.speed)} km/h (降 ${((1 - m.speed / v0) * 100).toFixed(0)}%)`);

  // 对照组：同样条件下纯收油（无扰流器）
  const m2 = toCruise();
  const v0b = m2.speed;
  sim(m2, 10, 1 / 60, (t, mm) => { mm._throttleAxis = 0; mm.brake = false; });
  check('扰流器比纯收油减速更有效', m.speed < m2.speed,
    `扰流器组 ${kmh(m.speed)} vs 纯收油组 ${kmh(m2.speed)} km/h (起点 ${kmh(v0)}/${kmh(v0b)})`);
}

// 扰流器在「进近减速」场景下的效果 —— 这才是玩家实际使用它的场景
{
  function toApproach() {
    const m = toCruise();
    // 下降到进近高度（300m）并减到进近速度
    for (let i = 0; i < 60 * 90; i++) {
      m._throttleAxis = 0; m.brake = false;
      m.inPitch = m.pos.y > 320 ? -0.25 : 0.05;
      m.update(1 / 60, flat);
      if (m.pos.y < 320 && m.pos.y > 250 && m.speed < 95) break;
    }
    return m;
  }
  const m = toApproach();
  const v0 = m.speed, h0 = m.pos.y;
  sim(m, 10, 1 / 60, (t, mm) => { mm._throttleAxis = 0; mm.brake = true; mm.inPitch = 0.02; });
  check('进近时空放扰流器能明显减速', m.speed < v0 * 0.92,
    `V: ${kmh(v0)} → ${kmh(m.speed)} km/h (降 ${((1 - m.speed / v0) * 100).toFixed(0)}%, 10s, 起始高度 ${h0.toFixed(0)}m)`);
}

// 扰流器升力损失：构造完全相同的平飞状态，只切换扰流器对比垂速
{
  function levelFlight(spoilerOn) {
    const m = makeM();
    m.onGround = false;
    m.pos.set(0, 300, 0);
    m.vel.set(0, 0, 110);
    m.pitch = 0; m.yaw = 0; m.roll = 0;
    m.throttle = 0.45; m.flap = 0.6;
    m.syncQuat();
    for (let i = 0; i < 360; i++) { m.brake = spoilerOn; m._throttleAxis = 0; m.update(1 / 60, flat); }
    return m;
  }
  const a = levelFlight(false), b = levelFlight(true);
  check('扰流器打开会损失升力（垂速下降）', b.vel.y < a.vel.y - 5,
    `同样平飞 6s：无扰流 垂速 ${a.vel.y.toFixed(1)} m/s → 有扰流 ${b.vel.y.toFixed(1)} m/s (差 ${(b.vel.y - a.vel.y).toFixed(1)} m/s)，扰流器量=${b.spoiler.toFixed(2)}`);
}

// ================= 6. 接 地 与 制动 =================
{
  const m = makeM();
  // 从空中以80 m/s、轻微下沉率飞入并接地（跑道上，朝向沿跑道）
  m.onGround = false;
  m.pos.set(0, PHYS.gearHeight + 1.2, -800);
  m.vel.set(0, -0.4, 80);
  m.yaw = 0; m.pitch = 0; m.roll = 0;
  m.syncQuat();
  // 用真实飞行直到接地（0.4 m/s 下沉需数秒，给足帧数）
  let td = null;
  for (let i = 0; i < 600 && !td; i++) {
    const prev = m.pos.clone();
    m._throttleAxis = 0; m.inPitch = 0; m.inYaw = 0;
    m.update(1 / 60, flat);
    td = m.checkTouchdown(flat, prev);
  }
  check('接地检测正确捕获着陆', td !== null && m.onGround,
    td ? `下沉率 ${td.sink.toFixed(2)} m/s, 速度 ${(td.speed * 3.6).toFixed(0)} km/h, 接地点 z=${td.z.toFixed(0)}` : '未捕获');

  const z0 = m.pos.z;
  let stopT = null;
  sim(m, 60, 1 / 60, (t, mm) => {
    mm._throttleAxis = 0; mm.brake = true; mm.inYaw = 0; mm.inPitch = 0;
    if (stopT === null && mm.speed < PHYS.stopSpeed) stopT = t;
  });
  check('接地后全刹车停稳且不出跑道', stopT !== null && Math.abs(m.pos.z) < 1500,
    `制动 ${Math.abs(m.pos.z - z0).toFixed(0)}m 停稳 (${stopT !== null ? stopT.toFixed(1) + 's' : '>60s'}), 终点 z=${m.pos.z.toFixed(0)} (跑道 ±1500)`);
}

// ================= 6b. 高速接地扫掠检测（防穿透） =================
{
  const m = makeM();
  m.onGround = false;
  m.pos.set(0, PHYS.gearHeight + 0.15, -800);
  // 极高速 + 极快下沉：单帧位移远大于「机身原点 - 地面」的判定间隙
  m.vel.set(0, -60, 400);
  m.yaw = 0; m.pitch = 0; m.roll = 0; m.syncQuat();
  const prev = m.pos.clone();
  const yBefore = m.pos.y;
  m._throttleAxis = 0; m.inPitch = 0; m.inYaw = 0;
  m.update(1 / 60, flat);
  const step = Math.abs(m.pos.y - yBefore);
  const td = m.checkTouchdown(flat, prev);
  check('高速接地不穿透（扫掠检测生效）', td !== null && m.pos.y >= PHYS.gearHeight - 1e-6,
    td ? `下沉 60m/s + 前进 400m/s, 单帧位移 ${step.toFixed(2)}m → 捕获接地并锁定在地面 (sink=${td.sink.toFixed(0)})`
       : `穿透漏检 (单帧位移 ${step.toFixed(2)}m, y=${m.pos.y.toFixed(2)})`);
}

// ================= 7. 硬着陆应被检出 =================
{
  const m = makeM();
  m.onGround = false;
  m.pos.set(0, PHYS.gearHeight + 1.5, 0);
  m.vel.set(0, -3.5, 70);      // 下沉率 3.5 m/s → 超过 1.0 阈值 = 重着陆
  m.yaw = 0; m.pitch = 0; m.roll = 0; m.syncQuat();
  let td = null;
  for (let i = 0; i < 30 && !td; i++) {
    const prev = m.pos.clone();
    m._throttleAxis = 0; m.inPitch = 0; m.inYaw = 0;
    m.update(1 / 60, flat);
    td = m.checkTouchdown(flat, prev);
  }
  check('重着陆被检出（下沉率超限）', td !== null && td.sink > PHYS.touchdownMaxSink,
    td ? `下沉率 ${td.sink.toFixed(2)} m/s > 阈值 ${PHYS.touchdownMaxSink} m/s → 应判失败` : '未捕获');
}

// ================= 8. 转弯 =================
{
  const m = makeM();
  sim(m, 45, 1 / 60, () => { m._throttleAxis = 1; });
  sim(m, 12, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = t < 3 ? 0.6 : 0.15; });
  const h0 = m.headingDeg;
  // 压 35° 坡度保持转弯
  sim(m, 12, 1 / 60, (t, mm) => {
    mm._throttleAxis = 1; mm.inPitch = 0.25;
    mm.inRoll = mm.roll / DEG < 35 ? 0.6 : 0;
  });
  let dh = (m.headingDeg - h0 + 540) % 360 - 180;
  check('压坡度+抬头能形成有效转弯', Math.abs(dh) > 15 && Math.abs(m.roll / DEG) < 90,
    `12s 航向变化 ${dh.toFixed(0)}°, 坡度 ${(m.roll / DEG).toFixed(0)}°, V=${kmh(m.speed)} km/h`);

  // 松杆自动回平
  sim(m, 8, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = 0.1; mm.inRoll = 0; });
  check('松杆后自动回平（防螺旋）', Math.abs(m.roll / DEG) < 25,
    `松杆 8s 后坡度 ${(m.roll / DEG).toFixed(1)}°`);
}

// ================= 9. 操纵惯性 =================
{
  const m = makeM();
  sim(m, 45, 1 / 60, () => { m._throttleAxis = 1; });
  sim(m, 12, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inPitch = t < 3 ? 0.6 : 0; });
  const r0 = m.roll, p0 = m.pitch;
  sim(m, 1 / 60, (t, mm) => { mm._throttleAxis = 1; mm.inRoll = 1; mm.inPitch = 1; });
  check('单帧操纵不会瞬转（有惯性）',
    Math.abs(m.roll - r0) / DEG < 3 && Math.abs(m.pitch - p0) / DEG < 2,
    `单帧(16.7ms): 滚转 ${((m.roll - r0) / DEG).toFixed(2)}°, 俯仰 ${((m.pitch - p0) / DEG).toFixed(2)}° (目标速率 ${PHYS.rollRate}/${PHYS.pitchRate} rad/s)`);
}

// ================= 10. 侧滑必须耗散能量（防能量注入回归） =================
// 历史上曾出现侧力符号写反，导致转弯时侧滑角单调增大并向飞机注入能量，
// 表现为速度从 288 飙到 926 km/h。此项专门守住该回归。
{
  const m = makeM();
  m.onGround = false;
  m.pos.set(0, 360, 1168);
  m.vel.set(0, 0, 80);          // 80 m/s 纯前进
  m.pitch = -0.38; m.roll = 0.44; m.yaw = 0;
  m.throttle = 0.54; m.flap = 1; m.alpha = 0.05;
  m.syncQuat();
  const v0 = m.speed;
  for (let i = 0; i < 60 * 8; i++) { m._throttleAxis = 0; m.inPitch = 0; m.inRoll = 0; m.update(1 / 60, flat); }
  check('转弯时侧滑角收敛（侧力为阻尼）', Math.abs(m.slip) < 25 * DEG,
    `8s 后侧滑 ${(Math.abs(m.slip) / DEG).toFixed(1)}°`);
  check('转弯时速度不失控（侧力不注入能量）', m.speed < v0 * 1.6,
    `V: ${(v0 * 3.6).toFixed(0)} → ${(m.speed * 3.6).toFixed(0)} km/h (8s，转弯+油门54%)`);
}

// ================= 11. 满舵滚转不得翻倒（滚转阻尼回归） =================
// 历史上缺少滚转阻尼时，持续按住方向键 10 秒可滚到 176°（倒扣）。
{
  const m = makeM();
  m.onGround = false;
  m.pos.set(0, 300, 0);
  m.vel.set(0, 0, 90);
  m.throttle = 0.6; m.flap = 1; m.alpha = 0.05; m.pitch = 0.02;
  m.syncQuat();
  let maxRoll = 0;
  const hdg0 = m.headingDeg;
  for (let i = 0; i < 60 * 12; i++) {
    m._throttleAxis = 0; m.inPitch = 0.05; m.inRoll = -1;   // 满舵右滚
    m.update(1 / 60, flat);
    maxRoll = Math.max(maxRoll, Math.abs(m.roll));
  }
  check('持续满舵滚转 12s 不会翻倒（滚转阻尼生效）', maxRoll < 85 * DEG,
    `最大坡度 ${(maxRoll / DEG).toFixed(1)}° (期望 <85°)`);
  check('满舵滚转能产生有效转向', Math.abs(m.headingDeg - hdg0) > 40,
    `航向 ${hdg0.toFixed(0)}° → ${m.headingDeg.toFixed(0)}°`);

  // 反向：满舵左滚也应对称
  const m2 = makeM();
  m2.onGround = false;
  m2.pos.set(0, 300, 0);
  m2.vel.set(0, 0, 90);
  m2.throttle = 0.6; m2.flap = 1; m2.alpha = 0.05; m2.pitch = 0.02;
  m2.syncQuat();
  let maxRoll2 = 0;
  for (let i = 0; i < 60 * 12; i++) {
    m2._throttleAxis = 0; m2.inPitch = 0.05; m2.inRoll = 1;    // 满舵左滚
    m2.update(1 / 60, flat);
    maxRoll2 = Math.max(maxRoll2, Math.abs(m2.roll));
  }
  check('左右滚转对称', Math.abs(maxRoll - maxRoll2) < 5 * DEG,
    `右 ${(maxRoll / DEG).toFixed(1)}° vs 左 ${(maxRoll2 / DEG).toFixed(1)}°`);
}

// ================= 12. 大坡度自动协调（FBW 协调功能） =================
// 背景：新手最常见的坠机原因是「压了坡度忘记拉杆补偿」，
// 升力垂直分量不足 → 持续掉高度。修复前按住滚转键 12 秒会掉 218m。
// 修复后应显著减缓，且飞机仍能持续转弯（不能把转弯能力也锁死）。
{
  const m = makeM();
  m.onGround = false;
  m.pos.set(0, 300, 0);
  m.vel.set(0, 0, 90);
  m.throttle = 0.7; m.flap = 1; m.alpha = 0.05;
  m.syncQuat();
  const alt0 = m.pos.y;
  let minAlt = alt0;
  for (let i = 0; i < 60 * 12; i++) {
    m._throttleAxis = 0; m.inRoll = -1; m.inPitch = 0;   // 满舵压坡度，不拉杆
    m.update(1 / 60, flat);
    minAlt = Math.min(minAlt, m.pos.y);
  }
  const lost = alt0 - minAlt;
  check('大坡度自动协调减缓掉高度', lost < 150,
    `满舵压坡度 12s，高度损失 ${lost.toFixed(0)}m (修复前 218m), 最低 ${minAlt.toFixed(0)}m`);

  const hdg = (m.headingDeg > 180 ? m.headingDeg - 360 : m.headingDeg);
  check('协调保护不锁死转弯能力', Math.abs(hdg) > 40,
    `12s 航向变化 ${hdg.toFixed(0)}° (坡度 ${(m.roll / DEG).toFixed(0)}°)`);
}

// ================= 汇总 =================
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('未通过：');
  failed.forEach((f) => console.log(`  - ${f.name}\n      ${f.detail}`));
  process.exit(1);
}
