/**
 * 浏览器端端到端测试 —— 真实 Chromium + 真实 WebGL + 真实键盘事件。
 * 用法: node tools/e2e.mjs [url]
 *
 * 说明：这是自动化脚本驱动的实机验证，不等同于人手试玩。
 * 它能验证：渲染是否成功、键盘是否生效、检查点是否计分、胜负判定、
 * 重开是否清状态 —— 但无法替代真人对"手感/画面"的评价。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(38)} ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: EXE,
  headless: true,
  args: [
    '--no-sandbox', '--disable-gpu-sandbox',
    // 仅启用 SwiftShader 软件光栅化。实测：加 --use-angle=swiftshader 反而掉到 3.8fps，
    // 不加则可稳定 60fps。物理逻辑仅 0.01ms/帧，瓶颈完全在光栅化，不在游戏代码。
    '--enable-unsafe-swiftshader',
    '--no-proxy-server',                        // 本机常驻代理会劫持 127.0.0.1
    '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });

// ---------- 1. 启动与渲染 ----------
try {
  await page.waitForFunction(() => window.__game && window.__game.model, { timeout: 20000 });
  const info = await page.evaluate(() => {
    const g = window.__game;
    return {
      phase: g.phase,
      pos: g.model.pos.toArray().map((v) => +v.toFixed(1)),
      speed: +g.model.speed.toFixed(2),
      onGround: g.model.onGround,
      colliders: g.env.colliders.length,
      cpCount: g.cps.list.length,
      drawCalls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles,
      textures: g.renderer.info.memory.textures,
      geometries: g.renderer.info.memory.geometries,
      loadingHidden: (() => {
      const el = document.getElementById('loading');
      if (!el) return true;
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden' ||
             parseFloat(cs.opacity) < 0.15 ||
             el.classList.contains('hidden') || el.classList.contains('hide') ||
             el.classList.contains('done');   // done = 淡出动画已开始/结束
    })(),
    loadingInfo: (() => {
      const el = document.getElementById('loading');
      if (!el) return 'removed';
      const cs = getComputedStyle(el);
      return `display=${cs.display} opacity=${cs.opacity} cls="${el.className}"`;
    })(),
    };
  });
  log(true, '游戏成功初始化', `phase=${info.phase}, 飞机@${info.pos.join(',')}, 检查点 ${info.cpCount} 个, 碰撞盒 ${info.colliders}`);
  log(info.drawCalls > 0 && info.drawCalls < 400, 'WebGL 渲染正常', `draw calls=${info.drawCalls}, 三角面=${info.triangles.toLocaleString()}, 纹理=${info.textures}, 几何体=${info.geometries}`);
  log(info.loadingHidden, '加载遮罩已隐藏', `loading: ${info.loadingInfo}`);
  await page.screenshot({ path: join(SHOTS, '01-menu.png') });
} catch (e) {
  log(false, '游戏成功初始化', e.message);
  console.log('\n页面错误:', errors.slice(0, 10));
  await browser.close();
  process.exit(1);
}

// ---------- 2. 菜单 → 开始 ----------
await page.click('#btn-start');
await sleep(600);
let st = await page.evaluate(() => ({ phase: window.__game.phase, timer: window.__game.timer }));
log(st.phase === 'ready', '点击开始 → 进入待起飞', `phase=${st.phase}, timer=${st.timer.toFixed(2)}`);

// ---------- 3. 键盘输入生效性 ----------
{
  const before = await page.evaluate(() => ({
    thr: window.__game.model.throttle,
    pitch: window.__game.model.pitch,
  }));
  await page.keyboard.down('KeyW');
  await sleep(1200);
  await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => ({
    thr: window.__game.model.throttle,
    speed: window.__game.model.speed,
    throttlePct: document.getElementById('throttle-pct')?.textContent,
    speedTxt: document.getElementById('speed-val')?.textContent,
  }));
  log(after.thr > before.thr + 0.3, 'W 键加油门生效', `油门 ${before.thr.toFixed(2)} → ${after.thr.toFixed(2)}, HUD 油门显示 "${after.throttlePct}"`);
  log(parseFloat(after.speedTxt) > 1, 'HUD 速度随状态更新', `速度 ${after.speed.toFixed(1)} m/s, HUD 显示 "${after.speedTxt}"`);

  // 油门保持型：松手后不回中
  await sleep(700);
  const hold = await page.evaluate(() => window.__game.model.throttle);
  log(Math.abs(hold - after.thr) < 0.01, '油门为保持型（松手不回中）', `松手 0.7s 后油门 ${hold.toFixed(2)}`);

  // 刹车
  const b0 = await page.evaluate(() => window.__game.model.speed);
  await page.keyboard.down('Space');
  await sleep(1500);
  await page.keyboard.up('Space');
  const b1 = await page.evaluate(() => window.__game.model.speed);
  log(b1 < b0, '空格刹车生效', `速度 ${b0.toFixed(1)} → ${b1.toFixed(1)} m/s`);
}

// ---------- 4. 起飞全流程 + 检查点 ----------
{
  // 状态注入辅助：把飞机放到指定状态（仅用于验证判定逻辑，不改变游戏规则）
  const place = async (opts) => page.evaluate((o) => {
    const m = window.__game.model;
    m.onGround = o.onGround ?? false;
    m.pos.set(o.x, o.y, o.z);
    m.vel.set(o.vx ?? 0, o.vy ?? 0, o.vz ?? 0);
    m.yaw = o.yaw ?? 0; m.pitch = o.pitch ?? 0; m.roll = o.roll ?? 0;
    m.pitchRate = 0; m.rollRate = 0; m.yawRate = 0;
    m.syncQuat();
    const g = window.__game;
    g.chase.reset();
    // 关键：必须同步 _prevPos，否则主循环下一帧会拿到「上一帧的旧位置」，
    // 与新位置相距上千米，穿越平面判定与接地扫掠都会失效。
    g._prevPos.copy(m.pos);
    if (o.cpIndex !== undefined) {
      g.cpIndex = o.cpIndex;
      g.cps.list.forEach((c, i) => g.cps.setState(i, i < o.cpIndex ? 'done' : (i === o.cpIndex ? 'active' : 'pending')));
    }
    // 重置每个环的内部通过时间戳，否则 CP_MIN_GAP 会导致穿越被跳过
    g.cps.list.forEach((c) => { c.passedAt = -Infinity; });
    if (o.clearRecords) { g.cpRecords.length = 0; }
    g.cpPassedAt.fill(-Infinity);
  }, opts);

  const readState = () => page.evaluate(() => {
    const g = window.__game;
    return {
      phase: g.phase, cpIndex: g.cpIndex, timer: g.timer,
      cpStates: g.cps.list.map((c) => c.state),
      pos: g.model.pos.toArray(),
      speed: g.model.speed,
      failReason: g.failReason,
      onGround: g.model.onGround,
      alt: g.model.pos.y,
      cpRecords: g.cpRecords.length,
    };
  });

  // --- 检查点顺序验证：先传第 2 个，不应计分 ---
  const CP = [
    { id: 1, pos: [0, 300, 1150], radius: 95 },
    { id: 2, pos: [850, 460, 2500], radius: 110 },
    { id: 3, pos: [-620, 380, 2450], radius: 110 },
  ];
  // 从 CP2 前方 300m 沿法线方向飞入（cpIndex=0，CP2 不是 active）
  await place({ x: 984, y: 420, z: 2183, vx: -33, vz: 105, cpIndex: 0 });
  await sleep(400);
  let s = await readState();
  log(s.cpIndex === 0, '顺序保护：不按序穿越不计分', `穿越 CP2 区域后 cpIndex=${s.cpIndex} (期望 0), 记录数=${s.cpRecords}`);

  // --- 正向穿越 CP1 ---
  await place({ x: 0, y: 300, z: 870, vz: 110, cpIndex: 0 });
  await sleep(3000);
  s = await readState();
  log(s.cpIndex === 1, '正确穿越检查点 1', `cpIndex=${s.cpIndex} (期望 1), 状态=${s.cpStates.join(',')}`);
  const toast1 = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
  log(toast1.includes('1'), '检查点通过有文字反馈', `toast="${toast1.trim()}"`);
  await page.screenshot({ path: join(SHOTS, '02-cp1.png') });

  // --- 重复穿越 CP1 不应重复计分 ---
  await place({ x: 0, y: 300, z: 870, vz: 110, cpIndex: 1 });
  await sleep(3000);
  await place({ x: 0, y: 300, z: 870, vz: 110, cpIndex: 1 });
  await sleep(3000);
  s = await readState();
  log(s.cpRecords === 1, '不可重复刷分（CP1 只记一次）', `cpRecords=${s.cpRecords} (期望 1), cpIndex=${s.cpIndex}`);

  // --- 穿越 CP2、CP3 ---
  await place({ x: 984, y: 420, z: 2183, vx: -33, vz: 105, cpIndex: 1 });
  await sleep(3600);
  s = await readState();
  log(s.cpIndex === 2, '正确穿越检查点 2', `cpIndex=${s.cpIndex} (期望 2), 状态=${s.cpStates.join(',')}`);

  await place({ x: -426, y: 360, z: 3200, vx: 50, vz: 98, cpIndex: 2 });
  await sleep(3600);
  s = await readState();
  log(s.cpIndex === 3, '正确穿越检查点 3', `cpIndex=${s.cpIndex} (期望 3), 状态=${s.cpStates.join(',')}`);
  const toast3 = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
  log(toast3.includes('着陆') || toast3.includes('返场'), '全部完成后提示返场', `toast="${toast3.trim()}"`);
  await page.screenshot({ path: join(SHOTS, '03-all-cp.png') });

  // --- 失败：撞地 ---
  await place({ x: 2600, y: 70, z: 3000, vy: -40, vz: 70, cpIndex: 3 });
  await sleep(2200);
  s = await readState();
  log(s.phase === 'failed', '撞地判定失败', `phase=${s.phase}, reason=${s.failReason}`);
  const resVisible = await page.evaluate(() => {
    const el = document.getElementById('result');
    return !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
  });
  log(resVisible, '失败后显示结果页', `result 面板可见=${resVisible}`);
  const resData = await page.evaluate(() => ({
    title: document.getElementById('result-title')?.textContent,
    reason: document.getElementById('result-reason')?.textContent,
    time: document.getElementById('result-time')?.textContent,
    tips: (document.getElementById('result-tips')?.textContent || '').slice(0, 60),
  }));
  log(!!resData.title, '结果页含耗时与原因', `标题="${resData.title}", 原因="${resData.reason}", 耗时="${resData.time}"`);
  await page.screenshot({ path: join(SHOTS, '04-fail.png') });

  // --- 重开清状态 ---
  await page.click('#btn-restart');
  await sleep(700);
  s = await readState();
  const cleared = s.cpIndex === 0 && s.cpRecords === 0 && s.timer < 1.5 &&
                  s.cpStates.join(',') === 'active,pending,pending' && s.failReason === null;
  log(cleared, '重开清除上一局全部状态', `cpIndex=${s.cpIndex}, 记录=${s.cpRecords}, timer=${s.timer.toFixed(2)}s, 检查点状态=${s.cpStates.join(',')}, failReason=${s.failReason}`);

  // --- 成功流程：3 个检查点 + 安全着陆 ---
  await place({ x: 0, y: 300, z: 870, vz: 110, cpIndex: 0 });
  await sleep(2800);
  await place({ x: 984, y: 420, z: 2183, vx: -33, vz: 105, cpIndex: 1 });
  await sleep(3400);
  await place({ x: -426, y: 360, z: 3200, vx: 50, vz: 98, cpIndex: 2 });
  await sleep(3400);
  s = await readState();
  const allCp = s.cpIndex === 3;

  // 稳定进近：在跑道中线，缓慢下降，60 m/s
  await place({ x: 0, y: 2.81, z: -200, vz: 62, vy: -0.2, yaw: 0, pitch: 0.02, cpIndex: 3 });
  await sleep(350);
  s = await readState();
  const landed = s.phase === 'landed' || s.phase === 'success';

  // 减速停稳：接地速度 ~223 km/h(62 m/s)，全刹车需约 20s 停稳
  await page.keyboard.down('KeyS');
  await page.keyboard.down('Space');
  let stopped = false;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const st = await readState();
    if (st.phase === 'success' || st.phase === 'failed') { stopped = true; break; }
  }
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyS');
  if (!stopped) await sleep(1500);
  s = await readState();
  log(allCp, '成功流程：三个检查点全部通过', `cpIndex=${s.cpIndex}, 检查点状态=${s.cpStates.join(',')}`);
  log(landed, '着陆被正确判定', `接地后 phase=${landed ? 'landed' : s.phase}`);
  log(s.phase === 'success', '完成着陆 → 判定成功', `phase=${s.phase}, 失败原因=${s.failReason}`);
  const winData = await page.evaluate(() => ({
    title: document.getElementById('result-title')?.textContent,
    time: document.getElementById('result-time')?.textContent,
    cp: document.getElementById('result-cp')?.textContent,
    landing: document.getElementById('result-landing')?.textContent,
  }));
  log(!!winData.time, '结果页展示耗时与着陆结果', `耗时="${winData.time}", 检查点="${(winData.cp || '').slice(0, 40)}", 着陆="${(winData.landing || '').slice(0, 50)}"`);
  await page.screenshot({ path: join(SHOTS, '05-success.png') });
}

// ---------- 5. 性能采样 ----------
{
  const perf = await page.evaluate(async () => {
    return new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      function tick() {
        frames++;
        if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
        else resolve({ fps: frames / ((performance.now() - t0) / 1000) });
      }
      requestAnimationFrame(tick);
    });
  });
  const info = await page.evaluate(() => ({
    calls: window.__game.renderer.info.render.calls,
    tris: window.__game.renderer.info.render.triangles,
    progs: window.__game.renderer.info.programs?.length || 0,
  }));
  // 注意：此环境为 SwiftShader 软件渲染，帧率不代表真实 GPU 表现
  log(true, '性能采样（软件渲染环境）', `fps≈${perf.fps.toFixed(1)}, draw calls=${info.calls}, 三角面=${info.tris.toLocaleString()}, shader程序=${info.progs}`);
}

// ---------- 汇总 ----------
const realErrors = errors.filter((e) => !/favicon|ERR_|Failed to load resource/i.test(e));
log(realErrors.length === 0, '无 JS 运行时错误', realErrors.length ? realErrors.slice(0, 5).join(' | ') : '无');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('未通过:');
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
}

writeFileSync(join(SHOTS, 'e2e-report.json'), JSON.stringify({ url: URL_, results, errors: realErrors }, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
