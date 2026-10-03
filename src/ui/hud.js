/**
 * HUD 层 —— 纯 DOM / Canvas2D，不依赖 three.js。
 * 所有文案为简体中文；文案常量（阶段名、失败原因）取自 core/constants.js。
 */

import { PHASE, FAIL_REASON } from '../core/constants.js';

// ---------------- 内部工具 ----------------
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const isNum = (v) => typeof v === 'number' && isFinite(v);

/** 秒 → "mm:ss.d" */
function fmtTime(sec) {
  const s = Math.max(0, isNum(sec) ? sec : 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/** 航向 → "043"（三位补零） */
function fmtHeading(deg) {
  let d = isNum(deg) ? Math.round(deg) % 360 : 0;
  if (d < 0) d += 360;
  return String(d).padStart(3, '0');
}

/** 垂直速度 → "+1.2"（1 位小数） */
function fmtVs(v) {
  let x = isNum(v) ? v : 0;
  if (Math.abs(x) < 0.05) x = 0;           // 避免出现 "-0.0"
  return (x >= 0 ? '+' : '') + x.toFixed(1);
}

/** 油门 0~1 或 0~100 → 0~100 整数 */
function fmtThrottle(t) {
  if (!isNum(t)) return 0;
  const pct = t <= 1.0001 ? t * 100 : t;
  return Math.round(clamp(pct, 0, 100));
}

/** 从警告文案自动判断语气（不改变 setWarning(text) 的签名） */
function guessTone(text) {
  if (/失败|错误|危险|警告|偏离|超时|不足|过大|禁止/.test(text)) return '';
  if (/完成|通过|成功|正确|已就绪|可以/.test(text)) return 'good';
  if (/注意|提示|请 |准备/.test(text)) return 'info';
  return '';
}

/** 从 toast 文案自动判断语气 */
function guessToastTone(text) {
  if (/失败|坠|撞|中断/.test(text)) return 'bad';
  if (/通过|完成|成功|太棒|不错/.test(text)) return 'good';
  return '';
}

const PHASE_TEXT = {
  [PHASE.MENU]: '待起飞',
  [PHASE.READY]: '待起飞',
  [PHASE.FLYING]: '飞行中',
  [PHASE.LANDED]: '已着陆',
  [PHASE.SUCCESS]: '任务完成',
  [PHASE.FAILED]: '任务失败',
};

const CP_STATE_TEXT = { done: '已通过', active: '当前目标', pending: '未通过' };

// ---------------- 姿态仪参数 ----------------
const ADI = {
  size: 260,
  r: 112,            // 圆盘半径
  pxPerDeg: 3.05,    // 俯仰角像素比例
  clipR: 108,        // 裁剪半径
};

export function createHUD() {
  // ---------- DOM 引用 ----------
  const el = {
    app: $('app'),
    hud: $('hud'),
    phaseLabel: $('phase-label'),
    timer: $('timer'),
    cpList: $('cp-list'),
    speed: $('speed-val'),
    alt: $('alt-val'),
    vs: $('vs-val'),
    heading: $('heading-val'),
    throttleFill: $('throttle-fill'),
    throttlePct: $('throttle-pct'),
    throttleBox: $('throttle-box'),
    attCanvas: $('attitude'),
    warning: $('warning'),
    toast: $('toast'),
    stallBar: $('stall-bar'),
    menu: $('menu'),
    result: $('result'),
    loading: $('loading'),
    btnStart: $('btn-start'),
    btnRestart: $('btn-restart'),
    btnMenu: $('btn-menu'),
    resTitle: $('result-title'),
    resReason: $('result-reason'),
    resTime: $('result-time'),
    resCp: $('result-cp'),
    resLanding: $('result-landing'),
    resTips: $('result-tips'),
  };

  const ctx = el.attCanvas ? el.attCanvas.getContext('2d') : null;

  // ---------- 外部回调 ----------
  let onStart = () => {}, onRestart = () => {}, onMenu = () => {};
  if (el.btnStart) el.btnStart.addEventListener('click', () => onStart());
  if (el.btnRestart) el.btnRestart.addEventListener('click', () => onRestart());
  if (el.btnMenu) el.btnMenu.addEventListener('click', () => onMenu());

  // ---------- 内部状态 ----------
  let toastTimer = 0;
  let flashTimer = 0;
  let headingDeg = 0;
  const cpItems = [];      // 检查点 <li> 复用池（避免每帧重建 DOM）

  // =========================================================
  // 加载遮罩
  // =========================================================
  function hideLoading() {
    if (!el.loading) return;
    el.loading.classList.add('done');
  }

  // =========================================================
  // 菜单
  // =========================================================
  function showMenu() {
    hideResult();
    el.menu.classList.remove('hidden');
    el.hud.classList.remove('show');
  }
  function hideMenu() {
    el.menu.classList.add('hidden');
  }

  // =========================================================
  // 阶段 / 计时
  // =========================================================
  function setPhase(phase) {
    if (el.phaseLabel) {
      el.phaseLabel.textContent = PHASE_TEXT[phase] || '待起飞';
      el.phaseLabel.dataset.phase = phase || '';
    }
    const flying = phase === PHASE.READY || phase === PHASE.FLYING || phase === PHASE.LANDED;
    el.hud.classList.toggle('show', flying);
    if (phase === PHASE.FLYING) setWarning('');
    if (phase === PHASE.MENU) {
      setStall(false);
      setWarning('');
    }
  }

  function setTimer(seconds) {
    if (el.timer) el.timer.textContent = fmtTime(seconds);
  }

  // =========================================================
  // 飞行数据（每帧调用，只改文本）
  // speed 单位 km/h；altitude 单位 m；vs 单位 m/s；throttle 0~1 或 0~100
  // =========================================================
  function setFlight(d) {
    const f = d || {};

    const spd = isNum(f.speed) ? Math.max(0, Math.round(f.speed)) : 0;
    if (el.speed) {
      el.speed.textContent = String(spd);
      el.speed.classList.toggle('warn', f.stall === true);
    }

    const alt = isNum(f.altitude) ? Math.max(0, Math.round(f.altitude)) : 0;
    if (el.alt) el.alt.textContent = String(alt);

    const vs = isNum(f.vs) ? f.vs : 0;
    if (el.vs) {
      el.vs.textContent = fmtVs(vs);
      el.vs.classList.toggle('up', vs > 0.05);
      el.vs.classList.toggle('down', vs < -0.05);
    }

    headingDeg = isNum(f.heading) ? f.heading : headingDeg;
    if (el.heading) el.heading.textContent = fmtHeading(headingDeg);

    const tp = fmtThrottle(f.throttle);
    if (el.throttleFill) el.throttleFill.style.width = tp + '%';
    if (el.throttlePct) el.throttlePct.textContent = String(tp);
    if (el.throttleBox) el.throttleBox.classList.toggle('spoiler', f.spoiler === true);

    setStall(f.stall === true);

    // 接地提示（只在滑行阶段给一次温和提醒，不覆盖其它警告）
    if (f.onGround === true && f.groundHint !== false) {
      // 不主动改警告，由外部决定；这里仅保证失速条不残留
      setStall(f.stall === true);
    }

    if (isNum(f.pitch) && isNum(f.roll)) {
      drawAttitude(f.pitch, f.roll, headingDeg);
    }
  }

  // =========================================================
  // 检查点列表
  // =========================================================
  function setCheckpoints(states, nextIndex) {
    const list = Array.isArray(states) ? states : [];
    // 数量变化时才重建
    if (cpItems.length !== list.length) {
      el.cpList.textContent = '';
      cpItems.length = 0;
      for (let i = 0; i < list.length; i++) {
        const li = document.createElement('li');
        li.className = 'cp-chip';
        el.cpList.appendChild(li);
        cpItems.push(li);
      }
    }
    for (let i = 0; i < list.length; i++) {
      const li = cpItems[i];
      const st = list[i] === 'done' ? 'done'
               : list[i] === 'active' ? 'active'
               : 'pending';
      li.textContent = String(i + 1);
      li.className = 'cp-chip ' + st;
      const isNext = isNum(nextIndex) ? nextIndex === i : st === 'active';
      li.title = `检查点 ${i + 1} · ${CP_STATE_TEXT[st]}${isNext ? '（下一个）' : ''}`;
    }
  }

  // =========================================================
  // 警告条 / 失速 / toast
  // =========================================================
  function setWarning(text) {
    if (!el.warning) return;
    if (!text) {
      el.warning.className = '';
      el.warning.textContent = '';
      return;
    }
    const tone = guessTone(text);
    el.warning.className = 'show' + (tone ? ' ' + tone : '');
    el.warning.textContent = text;
  }

  function setStall(on) {
    if (el.stallBar) el.stallBar.classList.toggle('show', on === true);
  }

  function toast(text, ms = 2200) {
    if (!el.toast) return;
    clearTimeout(toastTimer);
    el.toast.className = '';                    // 重置动画
    el.toast.textContent = text;
    // 强制回流后重新加类，保证连续调用也能重播
    void el.toast.offsetWidth;
    el.toast.style.animationDuration = Math.max(300, ms) + 'ms';
    el.toast.classList.add('show');
    if (guessToastTone(text)) el.toast.classList.add(guessToastTone(text));
    toastTimer = setTimeout(() => {
      el.toast.className = '';
    }, Math.max(300, ms));
  }

  function flash(kind) {
    if (!el.app) return;
    clearTimeout(flashTimer);
    el.app.classList.remove('flash-success', 'flash-fail');
    void el.app.offsetWidth;
    el.app.classList.add(kind === 'success' ? 'flash-success' : 'flash-fail');
    flashTimer = setTimeout(() => {
      el.app.classList.remove('flash-success', 'flash-fail');
    }, 720);
  }
  const flashSuccess = () => flash('success');
  const flashFail = () => flash('fail');

  // =========================================================
  // 人工地平仪（ADI）
  // =========================================================
  function drawAttitude(pitchDeg, rollDeg, headDeg) {
    if (!ctx) return;
    const S = ADI.size, C = S / 2;
    const p = clamp(isNum(pitchDeg) ? pitchDeg : 0, -90, 90);
    const r = isNum(rollDeg) ? rollDeg : 0;

    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(C, C, ADI.r, 0, Math.PI * 2);
    ctx.clip();

    // --- 天空 / 地面双色背景，随俯仰平移 + 随横滚旋转 ---
    ctx.save();
    ctx.translate(C, C);
    ctx.rotate((-r * Math.PI) / 180);
    const off = p * ADI.pxPerDeg;
    const span = ADI.r * 2.4;

    const skyGrad = ctx.createLinearGradient(0, -span + off, 0, off);
    skyGrad.addColorStop(0, '#2C6FA8');
    skyGrad.addColorStop(1, '#8FCBE8');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(-span, -span + off, span * 2, span);

    const gndGrad = ctx.createLinearGradient(0, off, 0, span + off);
    gndGrad.addColorStop(0, '#A9713C');
    gndGrad.addColorStop(1, '#5C3A1E');
    ctx.fillStyle = gndGrad;
    ctx.fillRect(-span, off, span * 2, span);

    // 地平线
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-span, off);
    ctx.lineTo(span, off);
    ctx.stroke();

    // --- 俯仰刻度：每 10° 一格（带数字），每 5° 短刻度 ---
    ctx.lineWidth = 1.5;
    ctx.font = '700 11px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = -30; d <= 30; d += 5) {
      if (d === 0) continue;
      const y = off - d * ADI.pxPerDeg;
      if (Math.abs(y) > ADI.r) continue;
      const major = d % 10 === 0;
      const w = major ? 26 : 12;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.moveTo(-w, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (major) {
        // 数字只画在左侧，避免左右两份挤在一起
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(-w - 20, y - 6, 15, 12);
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'right';
        ctx.fillText(String(Math.abs(d)), -w - 7, y);
      }
    }
    ctx.restore();

    // --- 外圈 ---
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(C, C, ADI.r, 0, Math.PI * 2);
    ctx.stroke();

    // --- 顶部航向刻度带（先画，避免被横滚三角压住）---
    const hdg = isNum(headDeg) ? headDeg : 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(C - ADI.r, C - ADI.r, ADI.r * 2, 24);
    ctx.clip();
    // 底衬，保证浅色天空下也看得清
    ctx.fillStyle = 'rgba(16, 18, 38, 0.55)';
    ctx.fillRect(C - ADI.r, C - ADI.r, ADI.r * 2, 24);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.2;
    const pxPerDeg = 1.5;
    const base = Math.round(hdg / 10) * 10;
    for (let d = -60; d <= 60; d += 10) {
      const deg = base + d;
      const x = C + (deg - hdg) * pxPerDeg;
      const major = ((deg % 30) + 360) % 30 === 0;
      ctx.beginPath();
      ctx.moveTo(x, C - ADI.r + 1);
      ctx.lineTo(x, C - ADI.r + (major ? 9 : 6));
      ctx.stroke();
      if (major) {
        const t = ((deg % 360) + 360) % 360;
        const label = t === 0 ? 'N' : t === 90 ? 'E' : t === 180 ? 'S' : t === 270 ? 'W' : String(t);
        ctx.font = '700 10px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(label, x, C - ADI.r + 11);
      }
    }
    ctx.restore();

    // --- 横滚三角（贴在航向带正下方，随横滚旋转）---
    ctx.save();
    ctx.translate(C, C);
    ctx.rotate((-r * Math.PI) / 180);
    ctx.fillStyle = Math.abs(r) > 45 ? '#FF5A5A' : '#FFC93C';
    ctx.beginPath();
    ctx.moveTo(0, -ADI.r + 26);
    ctx.lineTo(-8, -ADI.r + 40);
    ctx.lineTo(8, -ADI.r + 40);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 航向中心指针（固定，不随横滚转）
    ctx.fillStyle = '#FFC93C';
    ctx.beginPath();
    ctx.moveTo(C, C - ADI.r + 1);
    ctx.lineTo(C - 6, C - ADI.r - 7);
    ctx.lineTo(C + 6, C - ADI.r - 7);
    ctx.closePath();
    ctx.fill();

    // --- 底部航向数字 ---
    ctx.font = '800 13px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10,12,28,0.75)';
    ctx.strokeText(fmtHeading(hdg) + '°', C, C + ADI.r - 4);
    ctx.fillStyle = '#FFD968';
    ctx.fillText(fmtHeading(hdg) + '°', C, C + ADI.r - 4);

    // --- 固定的飞机参考符号（黄色三角 + 棕色翼杆）---
    const ax = C, ay = C;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#FFC93C';
    ctx.beginPath();
    ctx.moveTo(ax - 46, ay);
    ctx.lineTo(ax - 16, ay);
    ctx.moveTo(ax + 16, ay);
    ctx.lineTo(ax + 46, ay);
    ctx.stroke();
    ctx.fillStyle = '#FFC93C';
    ctx.beginPath();
    ctx.moveTo(ax, ay - 6);
    ctx.lineTo(ax - 7, ay + 7);
    ctx.lineTo(ax + 7, ay + 7);
    ctx.closePath();
    ctx.fill();
    // 中心圆点
    ctx.fillStyle = '#8A5A33';
    ctx.beginPath();
    ctx.arc(ax, ay, 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // =========================================================
  // 结果页
  // =========================================================
  function showResult(data) {
    const d = data || {};
    const ok = d.success === true;

    el.resTitle.textContent = ok ? '🛬 任务完成！' : '任务失败';
    el.resTitle.className = 'title ' + (ok ? 'ok' : 'bad');

    if (ok) {
      el.resReason.className = 'reason ok';
      el.resReason.textContent = '🎉 太棒了！你成功完成了全部航程并平稳着陆。';
    } else {
      el.resReason.className = 'reason';
      // 失败原因文案统一取自 FAIL_REASON
      const key = d.reason;
      const txt = (key && FAIL_REASON[key]) ? FAIL_REASON[key] : (key || '未知原因');
      el.resReason.textContent = '失败原因：' + txt;
    }

    el.resTime.textContent = fmtTime(d.timeSec);
    if (isNum(d.totalSec) && d.totalSec > 0) {
      el.resTime.title = '限时 ' + fmtTime(d.totalSec);
    }

    // --- 检查点 ---
    const cps = Array.isArray(d.checkpoints) ? d.checkpoints : [];
    el.resCp.textContent = '';
    if (cps.length === 0) {
      const p = document.createElement('div');
      p.className = 'land-none';
      p.textContent = '本次没有检查点记录。';
      el.resCp.appendChild(p);
    } else {
      for (let i = 0; i < cps.length; i++) {
        const c = cps[i] || {};
        const row = document.createElement('div');
        row.className = 'cp-row ' + (c.passed ? 'pass' : 'miss');
        const idx = document.createElement('span');
        idx.className = 'cp-idx';
        idx.textContent = String(c.id != null ? c.id : i + 1);
        const name = document.createElement('span');
        name.className = 'cp-name';
        name.textContent = c.passed ? '已通过' : '未通过';
        const t = document.createElement('span');
        t.className = 'cp-time';
        t.textContent = c.passed ? fmtTime(c.timeSec) : '—';
        row.append(idx, name, t);
        el.resCp.appendChild(row);
      }
    }

    // --- 着陆数据 ---
    el.resLanding.textContent = '';
    const L = d.landing;
    if (L && (isNum(L.sinkRate) || isNum(L.speed))) {
      if (isNum(L.sinkRate)) {
        // 下沉率：向下为负，取绝对值判断是否超过 1.0 m/s 的平稳上限
        addLand('接地下沉率', Math.abs(L.sinkRate).toFixed(1) + ' m/s',
          Math.abs(L.sinkRate) <= 1.0 ? 'ok' : 'bad');
      }
      if (isNum(L.speed)) {
        // 接地速度：主循环传入的是 m/s，显示需换算 km/h。
        // 平稳阈值与 PHYS.goodLandingSpeed(68 m/s ≈ 245 km/h) 保持一致。
        addLand('接地速度', Math.round(L.speed * 3.6) + ' km/h',
          L.speed <= 68 ? 'ok' : 'bad');
      }
      if (L.ok !== undefined) {
        addLand('是否平稳', L.ok ? '平稳接地 ✓' : '不够平稳 ✗', L.ok ? 'ok' : 'bad');
      }
      if (L.note) {
        const n = document.createElement('div');
        n.className = 'land-note';
        n.textContent = '说明：' + L.note;
        el.resLanding.appendChild(n);
      }
    } else {
      const n = document.createElement('div');
      n.className = 'land-none';
      n.textContent = '本次没有着陆接地数据（未成功落回跑道）。';
      el.resLanding.appendChild(n);
    }

    // --- 改进建议 ---
    el.resTips.textContent = '';
    const tips = Array.isArray(d.tips) ? d.tips.filter(Boolean) : [];
    const list = tips.length ? tips : ['多飞几次熟悉手感：先用小油门保持速度，再一点点加油门爬升。'];
    for (let i = 0; i < list.length; i++) {
      const li = document.createElement('li');
      li.textContent = String(list[i]);
      el.resTips.appendChild(li);
    }

    el.result.classList.remove('hidden');
    if (ok) flashSuccess(); else flashFail();
  }

  function addLand(label, value, cls) {
    const box = document.createElement('div');
    box.className = 'land-cell';
    const l = document.createElement('span');
    l.className = 'land-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'land-value' + (cls ? ' ' + cls : '');
    v.textContent = value;
    box.append(l, v);
    el.resLanding.appendChild(box);
  }

  function hideResult() {
    el.result.classList.add('hidden');
  }

  // ---------- 初始绘制一次，避免姿态仪空白 ----------
  drawAttitude(0, 0, 0);
  setPhase(PHASE.MENU);
  setTimer(0);
  setCheckpoints([], -1);
  setWarning('');

  // =========================================================
  return {
    onStart(cb) { onStart = typeof cb === 'function' ? cb : () => {}; },
    onRestart(cb) { onRestart = typeof cb === 'function' ? cb : () => {}; },
    onMenu(cb) { onMenu = typeof cb === 'function' ? cb : () => {}; },

    hideLoading,
    showMenu,
    hideMenu,

    setPhase,
    setTimer,
    setFlight,
    setCheckpoints,
    drawAttitude,

    setWarning,
    setStall,
    toast,
    flashSuccess,
    flashFail,

    showResult,
    hideResult,
  };
}
