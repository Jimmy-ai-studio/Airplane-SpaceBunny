/**
 * 试玩前自检：确认游戏能正常加载并进入可玩状态。
 * 顺便抓一张「起飞姿态」截图，你打开窗口就能对照。
 */
import { chromium } from 'playwright-core';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = 'C:/Users/lenovo/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL_ = 'http://127.0.0.1:8123/';

const b = await chromium.launch({
  executablePath: EXE, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.goto(URL_, { waitUntil: 'load', timeout: 30000 });
await p.waitForFunction(() => window.__game && window.__game.model, { timeout: 20000 });

const init = await p.evaluate(() => {
  const g = window.__game;
  return {
    phase: g.phase,
    colliders: g.env.colliders.length,
    cpCount: g.cps.list.length,
    calls: g.renderer.info.render.calls,
    tris: g.renderer.info.render.triangles,
  };
});
console.log('✓ 场景加载完成');
console.log(`  碰撞盒 ${init.colliders} 个, 检查点 ${init.cpCount} 个`);
console.log(`  draw calls ${init.calls}, 三角面 ${init.tris.toLocaleString()}`);

// 点开始 → 确认进入待起飞
await p.click('#btn-start');
await p.waitForTimeout(600);
const ready = await p.evaluate(() => {
  const g = window.__game;
  return { phase: g.phase, pos: g.model.pos.toArray().map((v) => Math.round(v)) };
});
console.log(`✓ 点击「开始飞行」→ phase=${ready.phase}, 飞机位于跑道 (${ready.pos})`);

// 截「等待起飞」画面：你打开窗口后应该看到同样的场景
await p.screenshot({ path: join(ROOT, 'shots', 'play-01-ready.png') });

// 真实键盘：加油门 → 抬轮 → 爬升，截「飞行中」画面
await p.keyboard.down('KeyW');
let lifted = false;
for (let i = 0; i < 30; i++) {
  await p.waitForTimeout(1000);
  const s = await p.evaluate(() => {
    const g = window.__game;
    return { onGround: g.model.onGround, y: Math.round(g.model.pos.y), kmh: Math.round(g.model.speed * 3.6) };
  });
  if (!s.onGround && s.y > 10) { lifted = true; break; }
  if (s.kmh > 255 && s.onGround) {
    await p.keyboard.down('ArrowUp');
    await p.waitForTimeout(420);
    await p.keyboard.up('ArrowUp');
  }
}
if (lifted) {
  // 爬升到 200m 左右截「飞行中」画面
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(400);
    const s = await p.evaluate(() => Math.round(window.__game.model.pos.y));
    if (s > 200) break;
  }
  const air = await p.evaluate(() => {
    const g = window.__game;
    return { y: Math.round(g.model.pos.y), kmh: Math.round(g.model.speed * 3.6), phase: g.phase };
  });
  await p.screenshot({ path: join(ROOT, 'shots', 'play-02-flying.png') });
  console.log(`✓ 起飞成功并爬升到 ${air.y}m, 速度 ${air.kmh} km/h, phase=${air.phase}`);
} else {
  console.log('✗ 起飞失败（异常）');
}
await p.keyboard.up('KeyW');

console.log(errs.length ? `✗ 运行错误: ${errs.slice(0, 3).join(' | ')}` : '✓ 无运行错误');
await b.close();
process.exit(0);
