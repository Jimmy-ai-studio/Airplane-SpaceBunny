/**
 * 真实飞行端到端测试 —— 全部用真实键盘事件操纵飞机完成完整航线。
 *
 * 与 e2e.mjs 的区别：本文件不注入任何游戏状态，只发按键，
 * 由游戏自身的物理与判定跑完全程。因此这是真正的"实玩"验证。
 *
 * 已知局限：自动驾驶脚本操作不等于人手操作，飞行品质/画面观感仍需人评。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });

const URL_ = process.argv[2] || 'http://127.0.0.1:8123/';
const EXE = 'C:/Users/lenovo/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const results = [];
const log = (ok, name, detail) => {
  results.push({ ok, name, detail });
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(40)} ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: EXE,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--no-proxy-server', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__game?.model, { timeout: 20000 });

// 读取状态（只读，不改）
const S = () => page.evaluate(() => {
  const g = window.__game, m = g.model;
  return {
    phase: g.phase, cpIndex: g.cpIndex, timer: +g.timer.toFixed(1),
    failReason: g.failReason, onGround: m.onGround, stall: m.stall,
    x: +m.pos.x.toFixed(0), y: +m.pos.y.toFixed(0), z: +m.pos.z.toFixed(0),
    kmh: +(m.speed * 3.6).toFixed(0), vs: +m.vel.y.toFixed(1),
    thr: +m.throttle.toFixed(2), heading: +m.headingDeg.toFixed(0),
    pitch: +(m.pitch * 57.3).toFixed(1), roll: +(m.roll * 57.3).toFixed(1),
    cpStates: g.cps.list.map((c) => c.state).join(','),
    toast: (document.getElementById('toast')?.textContent || '').trim(),
    hudSpeed: document.getElementById('speed-val')?.textContent,
    hudAlt: document.getElementById('alt-val')?.textContent,
    hudThr: document.getElementById('throttle-pct')?.textContent,
    gLoad: +m.gLoad.toFixed(2),
  };
});

const hold = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
  for (const k of keys) await page.keyboard.up(k);
};

/** 简易自动驾驶：朝目标点飞（用真实按键，无状态注入） */
async function flyTo(target, { maxMs = 90000, tolXZ = 130, tolY = 45, stop = null } = {}) {
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < maxMs) {
    const s = await S();
    if (stop && stop(s)) return { ok: true, s, ms: Date.now() - t0 };

    const dx = target[0] - s.x, dz = target[2] - s.z, dy = target[1] - s.y;
    const distXZ = Math.hypot(dx, dz);

    // 目标航向（游戏 heading: 0=+Z, 90=+X）
    const want = (Math.atan2(dx, dz) * 57.3 + 360) % 360;
    // 航向误差：不能直接用 (want - heading) 归一化 —— want 在 atan2 象限边界
    // 会跳变 180°，导致飞机反复大幅摆头、绕大圈却永远到不了目标。
    // 正确做法：用当前机头方向与「指向目标的水平单位向量」做点积/叉积，
    // 得到带符号的夹角（右转为正），在 ±180° 内连续。
    const hdgRad = s.heading * Math.PI / 180;
    let dh = 0;
    if (distXZ >= 1) {
      const ux = dx / distXZ, uz = dz / distXZ;
      const fwdX = Math.sin(hdgRad), fwdZ = Math.cos(hdgRad);
      const cross = fwdX * uz - fwdZ * ux;                 // >0 需右转
      const dot = Math.max(-1, Math.min(1, fwdX * ux + fwdZ * uz));
      dh = Math.atan2(cross, dot) * 57.3;
    }

    // 已进入检查点穿越邻域 → 交给主循环判定，不在此处返回
    const nearGate = distXZ < 420 && Math.abs(dy) < 130;

    // 倒扣/大俯仰时先改出：优先把俯仰拉回可用区间
    let pitchKey = null, rollKey = null, thrKey = null;

    if (nearGate) {
      // 已在环的穿越邻域内：
      // 1) 松开滚转键让飞机改平（靠 autopilot 自动回平）
      // 2) 只用俯仰把高度对准环心高度
      // 3) 保持航向直穿
      const nearKeys = [];
      // 俯仰微调：对准环心高度
      const dyGate = target[1] - s.y;
      if (dyGate > 25 && s.kmh > 240) nearKeys.push('ArrowUp');
      else if (dyGate < -25) nearKeys.push('ArrowDown');
      // 油门：维持穿越速度
      if (s.kmh < 300) nearKeys.push('KeyW');
      else if (s.kmh > 400) nearKeys.push('KeyS');
      for (const k of nearKeys) await page.keyboard.down(k);
      await sleep(85);
      for (const k of nearKeys) await page.keyboard.up(k);
      continue;
    }

    // ---- 横滚控制 ----
    // 之前用「if (|roll|>42) 收坡度 else 压坡度」两个互斥分支，
    // 会在阈值附近死锁：飞机稳在 42°（滚转阻尼上限附近），
    // 收坡度分支想减小、压坡度分支又压住，横跳不止 → 画大圈永远到不了目标。
    //
    // 正确做法：始终算出「目标坡度」，再用单一误差通道控制。
    // 目标坡度 = 航向误差映射的坡度，但要做「转弯半径限幅」：
    // 距离越近，允许的坡度越小，避免画出比目标更大的圆。
  const a = Math.abs(dh);
  const distFactor = Math.min(distXZ / 700, 1);
  // 近处收紧到 8°，远处放到 22°。物理滚转上限约 75°，留足余量避免超调。
  const maxBank = 8 + 14 * distFactor;
  let wantBank = 0;
  if (a > 6) {
    const gain = a > 100 ? 0.34 : a > 40 ? 0.26 : 0.40;
    wantBank = Math.max(-maxBank, Math.min(maxBank, -dh * gain));
  }
  // 关键：不再有互斥的改出分支，只按 wantBank - roll 的符号给一个方向的输入。
  // 死区必须够宽（4°）：单次按键脉冲就会带来数度坡度变化，
  // 死区太小会导致「按一下就过头」，反复累积成大坡度螺旋。
  const bankErr = wantBank - s.roll;
  if (bankErr > 4) rollKey = 'ArrowRight';             // roll 需变负 = 右转
  else if (bankErr < -4) rollKey = 'ArrowLeft';

      // 俯仰控制（优先级高于高度保持）：
      //  1) 俯仰角过大 → 立刻压杆（避免进入大仰角/失速/打转）
      //  2) 失速或速度低 → 先推杆再加油门（改出失速优先于保持高度）
      //  3) 正常 → 高度带闭环
      if (Math.abs(s.pitch) > 22) {
        pitchKey = s.pitch > 0 ? 'ArrowDown' : 'ArrowUp';
      } else if (s.stall) {
        pitchKey = 'ArrowDown';            // 失速：推杆改出
      } else if (s.kmh < 200) {
        pitchKey = 'ArrowUp';              // 速度不足：加油门 + 略抬头增升力
      } else {
      // 水平转弯：压坡度损失垂直升力 → 必须拉杆补偿
      // 升力垂直分量 = L·cos(bank)，bank=20° 需额外 ~6% 爬升，bank=30° 需 ~15%
      const bankDeg = Math.abs(s.roll);
      const comp = 6 + bankDeg * 0.55;
      const band = Math.max(40, Math.min(100, distXZ * 0.25));
      let wantVs;
      if (dy > band) wantVs = 12 + comp;              // 低于目标高度带：全力爬升
      else if (dy < -band) wantVs = -12;
      else wantVs = Math.max(-5, Math.min(5 + comp, dy * 0.30));  // 带内：温和修正

      if (s.vs < wantVs - 1.5) pitchKey = 'ArrowUp';
      else if (s.vs > wantVs + 2.5) pitchKey = 'ArrowDown';
    }

    // ---- 油门 ----
    // 转弯半径 ∝ v² / (g·tan(bank))。若带着高速度进弯，所需坡度会远超 maxBank，
    // 飞机只能靠加大坡度硬转 → 超调 → 进入大坡度螺旋。
    // 正确做法：入弯前主动收油减速，这是真实飞行员的操作。
    const turning = Math.abs(dh) > 25 && distXZ < 1500;
    if (s.stall || s.kmh < 230) thrKey = 'KeyW';
    else if (turning && s.kmh > 300) thrKey = 'KeyS';   // 入弯减速
    else if (s.kmh < 300) thrKey = 'KeyW';
    else if (s.kmh > 400) thrKey = 'KeyS';

    // 安全兜底：一旦姿态或速度失控，停止一切操纵输入并报告
    if (Math.abs(s.pitch) > 100 || s.kmh > 760 || s.y > 2900) {
      console.log(`   ✗ 失控! pitch=${s.pitch}° V=${s.kmh} alt=${s.y}m —— 中止本次导航`);
      return { ok: false, s, lost: true, ms: Date.now() - t0 };
    }

    const keys = [pitchKey, rollKey, thrKey].filter(Boolean);
    if (keys.length) for (const k of keys) await page.keyboard.down(k);
    // 关键：按键保持时间必须随误差自适应。
    // 固定 85ms 的脉冲无法把大坡度（例如 70°）拉回来 —— 滚转需要持续按压。
    // 误差大 → 按久一点；误差小 → 快速脉冲微调，避免过冲振荡。
    // 短脉冲 + 高频率：单次按键只带来 0.5~2° 坡度变化，配合 4° 死区可精确控坡度
    const errMag = Math.abs(bankErr);
    const holdMs = errMag > 40 ? 150 : errMag > 15 ? 90 : 60;
    await sleep(holdMs);
    if (keys.length) for (const k of keys) await page.keyboard.up(k);

    if (Date.now() - lastLog > 4000) {
      lastLog = Date.now();
      console.log(`   ↳ t=${((Date.now() - t0) / 1000).toFixed(0)}s 目标(${target}) 位置(${s.x},${s.y},${s.z}) V=${s.kmh} 航向${s.heading}→${want.toFixed(0)} 距${distXZ.toFixed(0)}m Δh${dy.toFixed(0)} vs${s.vs} pitch${s.pitch}° roll${s.roll}°`);
    }
    // 注意：不能用「接近目标点」作为到达判据 —— 环有 95~110m 半径，
    // 提前判定返回会导致飞机停在环外。唯一可靠的判据是 cpIndex 是否前进。
  }
  return { ok: false, s: await S(), ms: maxMs };
}

console.log('══════════ 真实飞行测试开始 ══════════\n');

// ---------- 1. 起飞 ----------
await page.click('#btn-start');
await sleep(400);
let s0 = await S();
log(s0.phase === 'ready', '开始游戏 → 待起飞', `phase=${s0.phase}, 位置(${s0.x},${s0.y},${s0.z})`);

// 全油门滑跑，到 250 km/h 以上后轻拉杆抬轮
await page.keyboard.down('KeyW');
const accelTrace = [];
let lifted = false;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  const s = await S();
  accelTrace.push(s.kmh);
  if (!s.onGround && s.y > 10) { lifted = true; log(true, '真实键盘起飞成功', `滑跑 ${i + 1}s 离地, 速度 ${s.kmh} km/h, 高度 ${s.y}m, 位置 z=${s.z}`); break; }
  // 达到抬轮速度就轻拉杆（模拟玩家操作）
  if (s.kmh > 255 && s.onGround) {
    await page.keyboard.down('ArrowUp');
    await sleep(450);
    await page.keyboard.up('ArrowUp');
  }
}
if (!lifted) {
  const s = await S();
  log(false, '真实键盘起飞成功', `45s 后仍未离地 (V=${s.kmh} km/h, z=${s.z}, 跑道末端1500, 滑跑 ${(s.z + 1150).toFixed(0)}m)`);
}
// 继续加油门爬升（温和拉杆，避免过度抬头导致掉速/失速）
for (let i = 0; i < 25; i++) {
  const s = await S();
  if (s.y > 270) break;
  // 目标爬升率约 12 m/s：高度差大且速度充足才拉杆
  if (s.kmh > 300 && s.y < 270) {
    await hold(['ArrowUp'], 220);
  } else {
    await page.keyboard.down('KeyW');
    await sleep(400);
    await page.keyboard.up('KeyW');
  }
}
await page.keyboard.up('KeyW');
await sleep(500);
let s1 = await S();
log(s1.y > 120, '爬升到巡航高度', `高度 ${s1.y}m, 速度 ${s1.kmh} km/h, 爬升率 ${s1.vs} m/s, 俯仰 ${s1.pitch}°, stall=${s1.stall}`);
log(!s1.onGround, '已离开地面进入飞行', `onGround=${s1.onGround}, phase=${s1.phase}`);
log(Math.abs(parseFloat(s1.hudAlt) - s1.y) < 12, 'HUD 高度与实际一致', `实际 ${s1.y}m vs HUD "${s1.hudAlt}"`);
log(Math.abs(parseFloat(s1.hudSpeed) - s1.kmh) < 4, 'HUD 速度与实际一致(km/h)', `实际 ${s1.kmh} km/h vs HUD "${s1.hudSpeed}"`);
await page.screenshot({ path: join(SHOTS, '10-climb.png') });

// ---------- 2. 依次穿越三个检查点 ----------
const CPS = [
  { id: 1, pos: [0, 300, 1150] },
  { id: 2, pos: [900, 420, 2450] },
  { id: 3, pos: [-300, 360, 3450] },
];

for (let i = 0; i < CPS.length; i++) {
  const cp = CPS[i];
  const before = await S();
  const r = await flyTo(cp.pos, {
    maxMs: 100000, tolXZ: 150, tolY: 60,
    stop: (s) => s.cpIndex > i,           // 目标：cpIndex 前进
  });
  const after = await S();
  const passed = after.cpIndex > i;
  log(passed, `真实穿越检查点 ${cp.id}`,
    `cpIndex ${before.cpIndex} → ${after.cpIndex}, 状态=${after.cpStates}, 用时 ${(r.ms / 1000).toFixed(1)}s, 当前位置(${after.x},${after.y},${after.z})`);
  if (passed) {
    log(after.toast.includes(String(i + 1)) || after.toast.length > 0, `检查点 ${cp.id} 有通过反馈`, `toast="${after.toast}"`);
  }
  if (!passed) {
    console.log(`   ✗ 未能穿越 CP${cp.id}，当前状态:`, JSON.stringify(after));
    await page.screenshot({ path: join(SHOTS, `1${i}-stuck-cp${cp.id}.png`) });
    break;
  }
  await page.screenshot({ path: join(SHOTS, `11-cp${cp.id}.png`) });
}

let s2 = await S();
const allCp = s2.cpIndex >= 3;
log(allCp, '三个检查点全部通过', `cpIndex=${s2.cpIndex}, 状态=${s2.cpStates}, 位置(${s2.x},${s2.y},${s2.z})`);
await page.screenshot({ path: join(SHOTS, '12-cp-done.png') });

if (!allCp) {
  console.log('   ⚠ 未完成全部检查点，跳过着陆与成功流程验证（失败路径测试仍会执行）');
} else {
  // ---------- 3. 返场着陆 ----------
  console.log('\n--- 返场着陆 ---');
  // 先飞到跑道入口上方（跑道 z=+1500 端，从北向南降落 → 朝 -Z）
  await flyTo([0, 120, 2600], { maxMs: 80000, tolXZ: 200, tolY: 50 });
  let s3 = await S();
  console.log(`   ↳ 进近点: (${s3.x},${s3.y},${s3.z}) V=${s3.kmh} 航向${s3.heading}`);

  // 对准跑道：飞到跑道中线上方
  await flyTo([0, 40, 1200], { maxMs: 60000, tolXZ: 120, tolY: 40 });
  s3 = await S();
  console.log(`   ↳ 对准跑道: (${s3.x},${s3.y},${s3.z}) V=${s3.kmh} 航向${s3.heading} 高度${s3.y}`);

  // 下降接地
  const landRes = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 70000) {
      const s = await S();
      if (s.onGround) return { ok: true, s, touchdown: true };
      if (s.phase === 'failed' || s.phase === 'success') return { ok: false, s, touchdown: false };
      // 收油到进近速度，缓慢下降，机头对准 -Z
      const keys = [];
      if (s.kmh > 250) keys.push('KeyS');
      if (s.y > 18) keys.push('ArrowDown');
      if (s.kmh < 160) keys.push('KeyW');
      for (const k of keys) await page.keyboard.down(k);
      await sleep(110);
      for (const k of keys) await page.keyboard.up(k);
    }
    return { ok: false, s: await S(), touchdown: false };
  })();

  const s4 = await S();
  log(landRes.touchdown, '真实着陆接地', `onGround=${s4.onGround}, phase=${s4.phase}, 位置(${s4.x},${s4.z}), 原因=${s4.failReason}`);

  // 刹停
  await page.keyboard.down('KeyS');
  await page.keyboard.down('Space');
  for (let i = 0; i < 25; i++) {
    await sleep(500);
    const s = await S();
    if (s.phase === 'success' || s.phase === 'failed') break;
  }
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyS');
  const s5 = await S();
  log(s5.phase === 'success', '完成着陆 → 任务成功', `phase=${s5.phase}, 失败原因=${s5.failReason}, 计时 ${s5.timer}s`);

  const win = await page.evaluate(() => {
    const r = document.getElementById('result');
    return {
      visible: !!r && !r.classList.contains('hidden') && getComputedStyle(r).display !== 'none',
      title: document.getElementById('result-title')?.textContent?.trim(),
      time: document.getElementById('result-time')?.textContent?.trim(),
      cp: document.getElementById('result-cp')?.textContent?.trim().slice(0, 70),
      landing: document.getElementById('result-landing')?.textContent?.trim().slice(0, 80),
    };
  });
  log(win.visible, '成功后弹出结果页', `可见=${win.visible}, 标题="${win.title}"`);
  log(!!win.time, '结果页展示耗时与着陆数据', `耗时=${win.time}, 检查点="${win.cp}", 着陆="${win.landing}"`);
  // 单位一致性：接地速度应显示 km/h 量级（150~350），不是 m/s 量级（40~100）
  const landingKmh = (win.landing || '').match(/接地速度\s*(\d+)\s*km\/h/);
  log(!landingKmh || (Number(landingKmh[1]) > 100 && Number(landingKmh[1]) < 500),
    '结果页接地速度单位正确(km/h)', `匹配到="${landingKmh ? landingKmh[0] : '无'}"`);
  await page.screenshot({ path: join(SHOTS, '13-landing-result.png') });

  // ---------- 4. 重开 ----------
  await page.click('#btn-restart');
  await sleep(600);
  const s6 = await S();
  const cleared = s6.cpIndex === 0 && s6.cpStates === 'active,pending,pending' && s6.failReason === null && s6.timer < 2;
  log(cleared, '成功后重开清空上一局状态', `cpIndex=${s6.cpIndex}, 状态=${s6.cpStates}, 计时=${s6.timer}s, 位置(${s6.x},${s6.y},${s6.z})`);
}

// ---------- 5. 失败路径（真实撞地） ----------
console.log('\n--- 失败路径：真实失速撞地 ---');
// 若上一步未判定胜负，先按 R 强制重开
await page.keyboard.press('KeyR');
await sleep(600);
// 起飞
await page.keyboard.down('KeyW');
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  const s = await S();
  if (!s.onGround && s.y > 10) break;
  if (s.kmh > 255 && s.onGround) {
    await page.keyboard.down('ArrowUp');
    await sleep(450);
    await page.keyboard.up('ArrowUp');
  }
}
await page.keyboard.up('KeyW');
// 收油门 + 持续拉满杆 → 失速坠毁
await page.keyboard.down('KeyS');
await page.keyboard.down('ArrowUp');
let failSeen = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const s = await S();
  if (s.phase === 'failed') { failSeen = s; break; }
}
await page.keyboard.up('ArrowUp');
await page.keyboard.up('KeyS');
const sf = await S();
log(sf.phase === 'failed', '失速撞地 → 判定失败', `phase=${sf.phase}, 原因="${sf.failReason}", 位置(${sf.x},${sf.y},${sf.z})`);
const failRes = await page.evaluate(() => {
  const r = document.getElementById('result');
  return {
    visible: !!r && !r.classList.contains('hidden') && getComputedStyle(r).display !== 'none',
    reason: document.getElementById('result-reason')?.textContent?.trim(),
    tips: (document.getElementById('result-tips')?.textContent || '').trim().slice(0, 90),
  };
});
log(failRes.visible, '失败后弹出结果页', `可见=${failRes.visible}, 原因="${failRes.reason}"`);
log((failRes.tips || '').length > 10, '结果页给出中文改进建议', `"${failRes.tips}..."`);
await page.screenshot({ path: join(SHOTS, '14-fail-real.png') });

// ---------- 6. 失败后重开（用键盘 R，避免按钮不可见时超时） ----------
await page.keyboard.press('KeyR');
await sleep(700);
const s7 = await S();
log(s7.phase === 'ready' && s7.cpIndex === 0 && s7.failReason === null,
  '失败后重开恢复初始状态', `phase=${s7.phase}, cpIndex=${s7.cpIndex}, 原因=${s7.failReason}, 位置(${s7.x},${s7.y},${s7.z})`);
const resetDom = await page.evaluate(() => {
  const r = document.getElementById('result');
  return { resultHidden: !!r && r.classList.contains('hidden') };
});
log(resetDom.resultHidden, '重开后结果页已关闭', `result hidden=${resetDom.resultHidden}`);

// ---------- 汇总 ----------
const realErrors = errors.filter((e) => !/favicon|ERR_|Failed to load resource/i.test(e));
log(realErrors.length === 0, '全程无 JS 运行时错误', realErrors.length ? realErrors.slice(0, 3).join(' | ') : '无');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('未通过:');
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
}
await browser.close();
process.exit(failed.length ? 1 : 0);
