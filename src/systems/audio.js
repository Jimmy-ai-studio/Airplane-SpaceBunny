/**
 * audio.js —— 游戏音频系统
 *
 * 设计原则：**零外部音频素材**。
 * 所有声音都由 Web Audio API 实时合成（振荡器 + 噪声缓冲 + 滤波器 + 包络），
 * 因此不引入任何 mp3/wav 文件，保持「纯代码、全离线、体积不增」的项目特性。
 *
 * 声音分四类：
 *   1. 持续音（Continuous）—— 发动机、风噪、滑跑滚动声，随状态连续变化
 *   2. 事件音（Event）      —— 离地、接地、检查点、失败、成功等一次性音效
 *   3. 循环警报（Alarm）    —— 失速警告、超速警告，按周期重复
 *   4. UI 音（UI）          —— 按钮点击、菜单悬停
 *
 * 浏览器自动播放策略：AudioContext 必须在用户手势后才能启动。
 * 所以提供 `unlock()`，在「开始飞行」按钮点击时调用一次。
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** 把 0..1 映射到人耳更自然的指数区间 */
const curve = (t) => Math.pow(clamp(t, 0, 1), 1.8);

export function createAudio() {
  // ================= 状态 =================
  let ctx = null;              // AudioContext（首次用户手势后才创建）
  let master = null;           // 主音量节点
  let sfxBus = null;           // 音效总线
  let engineBus = null;        // 引擎/环境音总线
  let noiseBuf = null;         // 复用的白噪声缓冲
  let unlocked = false;
  let muted = false;
  let volume = 0.7;

  // 持续音节点句柄
  const eng = {
    // 涡扇低频轰鸣
    osc1: null, osc2: null, oscGain1: null, oscGain2: null,
    // 高频"啸叫"（随转速出现的涡轮声）
    whine: null, whineGain: null,
    // 宽带噪声（风噪 / 滑跑滚动）
    noise: null, noiseFilter: null, noiseGain: null,
    // 跑道滚动低频（仅地面）
    rumble: null, rumbleGain: null,
  };

  // 循环警报句柄
  const alarm = {
    stall: null,      // { osc, gain, timer }
    overspeed: null,
    sink: null,       // 接近地面时的高频紧张音
  };

  // 平滑用：避免参数突变导致爆音（爆音 = 数字削波失真）
  const smooth = { rpm: 0, wind: 0, roll: 0 };

  // ================= 初始化 =================
  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;                    // 浏览器不支持音频 → 静默降级
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    // 轻度压限：防止多音叠加时削波
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    master.connect(comp);
    comp.connect(ctx.destination);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.9;
    sfxBus.connect(master);

    engineBus = ctx.createGain();
    engineBus.gain.value = 0.0;              // 由 setEngine 动态控制
    engineBus.connect(master);

    // 白噪声缓冲（2 秒，循环复用）
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    return ctx;
  }

  /** 用户手势后调用，解锁音频 */
  function unlock() {
    if (unlocked) return;
    const c = ensureCtx();
    if (!c) { unlocked = true; return; }
    if (c.state === 'suspended') c.resume();
    unlocked = true;
  }

  // ================= 基础工具 =================
  const now = () => (ctx ? ctx.currentTime : 0);

  /** 创建一个带 ADSR 包络的振荡器音 */
  function tone({
    type = 'sine', freq = 440, freq2 = null, dur = 0.3, gain = 0.3,
    attack = 0.01, decay = 0.08, sustain = 0.0, release = 0.2,
    detune = 0, dest = null, curveType = 'exp',
  }) {
    if (!ctx || muted) return null;
    const t0 = now();
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(freq, t0);
    if (freq2 !== null) {
      if (curveType === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq2), t0 + dur);
      else osc.frequency.linearRampToValueAtTime(Math.max(1, freq2), t0 + dur);
    }

    const g = ctx.createGain();
    const peak = Math.max(0.0001, gain);
    const sus = Math.max(0.0001, sustain * gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    if (sustain > 0) {
      g.gain.exponentialRampToValueAtTime(sus, t0 + attack + decay);
      g.gain.setValueAtTime(sus, t0 + Math.max(attack + decay, dur));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(attack + decay, dur) + release);
    } else {
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    }

    osc.connect(g);
    g.connect(dest || sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + release + 0.05);
    return osc;
  }

  /** 噪声爆音（用于撞击、摩擦、噪声层） */
  function noise({
    dur = 0.3, gain = 0.3, type = 'bandpass', freq = 1000, q = 1,
    freq2 = null, attack = 0.005, dest = null,
  }) {
    if (!ctx || muted) return null;
    const t0 = now();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;

    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(freq, t0);
    flt.Q.value = q;
    if (freq2 !== null) flt.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t0 + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(flt); flt.connect(g); g.connect(dest || sfxBus);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
    return src;
  }

  // ================= 1. 发动机与风噪（持续音） =================
  /**
   * 每帧调用，驱动持续音。
   * @param {object} s 状态
   *   throttle 0..1  油门
   *   speed    m/s   速度
   *   onGround bool  是否在地面
   *   stall    bool  失速
   *   altitude m     离地高度
   */
  function setEngine(s) {
    if (!ctx || !unlocked || muted) return;
    const t = now();
    const spd = s.speed || 0;
    const thr = clamp(s.throttle || 0, 0, 1);

    // --- 首次调用：创建常驻节点 ---
    if (!eng.osc1) {
      // 低频轰鸣：基频 + 二次谐波，比单一正弦更厚实
      eng.osc1 = ctx.createOscillator(); eng.osc1.type = 'sawtooth';
      eng.oscGain1 = ctx.createGain(); eng.oscGain1.gain.value = 0.0;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 3;
      eng.osc1.connect(lp); lp.connect(eng.oscGain1); eng.oscGain1.connect(engineBus);

      eng.osc2 = ctx.createOscillator(); eng.osc2.type = 'square';
      eng.oscGain2 = ctx.createGain(); eng.oscGain2.gain.value = 0.0;
      const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 180;
      eng.osc2.connect(lp2); lp2.connect(eng.oscGain2); eng.oscGain2.connect(engineBus);

      // 涡轮啸叫
      eng.whine = ctx.createOscillator(); eng.whine.type = 'triangle';
      eng.whineGain = ctx.createGain(); eng.whineGain.gain.value = 0.0;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 6;
      eng.whine.connect(bp); bp.connect(eng.whineGain); eng.whineGain.connect(engineBus);

      // 风噪 / 气流噪声
      eng.noise = ctx.createBufferSource();
      eng.noise.buffer = noiseBuf; eng.noise.loop = true;
      eng.noiseFilter = ctx.createBiquadFilter();
      eng.noiseFilter.type = 'bandpass'; eng.noiseFilter.frequency.value = 700; eng.noiseFilter.Q.value = 0.7;
      eng.noiseGain = ctx.createGain(); eng.noiseGain.gain.value = 0.0;
      eng.noise.connect(eng.noiseFilter); eng.noiseFilter.connect(eng.noiseGain);
      eng.noiseGain.connect(engineBus);

      // 跑道滚动低频（地面独有）
      eng.rumble = ctx.createBufferSource();
      eng.rumble.buffer = noiseBuf; eng.rumble.loop = true;
      const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 110; rf.Q.value = 1.2;
      eng.rumbleGain = ctx.createGain(); eng.rumbleGain.gain.value = 0.0;
      eng.rumble.connect(rf); rf.connect(eng.rumbleGain); eng.rumbleGain.connect(engineBus);

      eng.osc1.start(); eng.osc2.start(); eng.whine.start();
      eng.noise.start(); eng.rumble.start();
    }

    // --- 转速模型：地面静止时空转低怠速，飞行中随油门 ---
    // 怠速 0.18，大油门 1.0
    const rpmTarget = clamp(0.18 + thr * 0.82, 0, 1);
    // 平滑，避免油门突变导致音高跳变
    smooth.rpm = lerp(smooth.rpm, rpmTarget, 0.08);

    // 涡扇转子频率：约 24Hz 基频，叠 2 倍频
    const base = 24 + curve(smooth.rpm) * 88;
    eng.osc1.frequency.setTargetAtTime(base, t, 0.06);
    eng.osc2.frequency.setTargetAtTime(base * 1.503, t, 0.06);   // 略失谐，产生拍频
    eng.whine.frequency.setTargetAtTime(900 + curve(smooth.rpm) * 2100, t, 0.1);

    // 音量包络
    const on = 1;
    eng.oscGain1.gain.setTargetAtTime(curve(smooth.rpm) * 0.20 * on, t, 0.07);
    eng.oscGain2.gain.setTargetAtTime(curve(smooth.rpm) * 0.085 * on, t, 0.07);
    // 啸叫只在高油门时明显
    eng.whineGain.gain.setTargetAtTime(Math.max(0, smooth.rpm - 0.55) * 0.075 * on, t, 0.12);

    // 风噪：随速度平方增长（真实风噪∝v²），但设上限避免刺耳
    const windTarget = clamp((spd * spd) / 16000, 0, 1) * 0.16;
    smooth.wind = lerp(smooth.wind, windTarget, 0.06);
    eng.noiseGain.gain.setTargetAtTime(smooth.wind, t, 0.1);
    eng.noiseFilter.frequency.setTargetAtTime(500 + spd * 9, t, 0.12);

    // 地面滚动：只在地面且有速度时
    const rollTarget = s.onGround ? clamp(spd / 55, 0, 1) * 0.13 : 0;
    smooth.roll = lerp(smooth.roll, rollTarget, 0.1);
    eng.rumbleGain.gain.setTargetAtTime(smooth.roll, t, 0.08);

    // 总线：失速时引擎音闷掉一点（模拟功率损失）
    engineBus.gain.setTargetAtTime(s.stall ? 0.55 : 1.0, t, 0.15);
  }

  /** 停止所有持续音（回到菜单时用） */
  function silenceEngine() {
    if (!ctx) return;
    const t = now();
    engineBus.gain.setTargetAtTime(0.0001, t, 0.12);
  }

  /** 恢复持续音总线（重新开始时用） */
  function resumeEngine() {
    if (!ctx) return;
    engineBus.gain.setTargetAtTime(1.0, now(), 0.2);
  }

  // ================= 2. 事件音效 =================
  const EVENTS = {
    /** 菜单 / 开始按钮点击 */
    uiClick() {
      tone({ type: 'sine', freq: 660, freq2: 990, dur: 0.09, gain: 0.16, attack: 0.004, decay: 0.08 });
      tone({ type: 'triangle', freq: 1320, dur: 0.05, gain: 0.06, attack: 0.002, decay: 0.05 });
    },

    /** 引擎启动点火（开始游戏瞬间） */
    engineStart() {
      // 启动机的"咳嗽"：低频抖动 + 逐渐升高的转速
      noise({ dur: 0.5, gain: 0.20, type: 'lowpass', freq: 400, freq2: 120, q: 1.2, attack: 0.01 });
      tone({ type: 'sawtooth', freq: 28, freq2: 92, dur: 0.62, gain: 0.19, attack: 0.05, decay: 0.2, sustain: 0.5, release: 0.3 });
      tone({ type: 'square', freq: 55, freq2: 176, dur: 0.5, gain: 0.07, attack: 0.06, decay: 0.2, sustain: 0.4, release: 0.25 });
    },

    /** 离地 */
    takeoff() {
      // 抬轮瞬间：气流声增强 + 一声轻快上扬
      noise({ dur: 0.75, gain: 0.15, type: 'bandpass', freq: 800, freq2: 2200, q: 0.8, attack: 0.04 });
      const base = 392;
      [1, 1.26, 1.5].forEach((m, i) => {
        tone({ type: 'triangle', freq: base * m, freq2: base * m * 1.5, dur: 0.34,
               gain: 0.11 - i * 0.02, attack: 0.012, decay: 0.32 });
      });
    },

    /** 穿越检查点 —— 清亮的双音"叮咚" */
    checkpoint(index = 0) {
      // 音阶随序号上行（1→2→3 音高递增），给玩家"进度感"
      const steps = [523.25, 587.33, 659.25];  // C5 D5 E5
      const f = steps[clamp(index, 0, 2)];
      tone({ type: 'sine', freq: f, dur: 0.16, gain: 0.22, attack: 0.003, decay: 0.15 });
      setTimeout(() => {
        tone({ type: 'sine', freq: f * 1.5, dur: 0.5, gain: 0.20, attack: 0.004, decay: 0.45 });
        tone({ type: 'sine', freq: f * 2, dur: 0.42, gain: 0.07, attack: 0.004, decay: 0.4 });
      }, 105);
      // 轻微的空间感
      noise({ dur: 0.3, gain: 0.045, type: 'highpass', freq: 4000, attack: 0.005 });
    },

    /** 接地轮胎触地 —— 沉闷的"咚" + 摩擦 */
    touchdown() {
      tone({ type: 'sine', freq: 120, freq2: 52, dur: 0.24, gain: 0.30, attack: 0.004, decay: 0.22 });
      noise({ dur: 0.42, gain: 0.17, type: 'lowpass', freq: 900, freq2: 200, q: 1.0, attack: 0.006 });
      // 轮胎摩擦的"沙沙"
      noise({ dur: 0.55, gain: 0.075, type: 'bandpass', freq: 1700, freq2: 900, q: 0.6, attack: 0.05 });
    },

    /** 重着陆（判定失败）—— 更重的撞击 */
    hardLanding() {
      tone({ type: 'sine', freq: 96, freq2: 34, dur: 0.55, gain: 0.40, attack: 0.003, decay: 0.5 });
      noise({ dur: 0.7, gain: 0.30, type: 'lowpass', freq: 1400, freq2: 120, q: 1.4, attack: 0.004 });
      // 金属结构应力声
      tone({ type: 'square', freq: 220, freq2: 90, dur: 0.35, gain: 0.10, attack: 0.004, decay: 0.32 });
    },

    /** 坠毁 / 撞地解体 */
    crash() {
      // 低频冲击
      tone({ type: 'sine', freq: 78, freq2: 26, dur: 0.9, gain: 0.42, attack: 0.003, decay: 0.85 });
      // 碎片般的宽带噪声
      noise({ dur: 1.0, gain: 0.34, type: 'lowpass', freq: 2600, freq2: 90, q: 0.8, attack: 0.003 });
      // 二次爆响
      setTimeout(() => {
        noise({ dur: 0.5, gain: 0.16, type: 'bandpass', freq: 600, freq2: 160, q: 1.0, attack: 0.006 });
        tone({ type: 'sine', freq: 60, freq2: 22, dur: 0.6, gain: 0.20, attack: 0.006, decay: 0.55 });
      }, 110);
      // 玻璃/金属碎片高频
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          noise({ dur: 0.12, gain: 0.07, type: 'highpass', freq: 3500 + Math.random() * 3000, attack: 0.002 });
        }, 180 + i * 85 + Math.random() * 60);
      }
    },

    /** 失败（未坠毁的判定失败，如超时/超界） */
    fail() {
      [440, 392, 330, 262].forEach((f, i) => {
        setTimeout(() => {
          tone({ type: 'triangle', freq: f, dur: 0.26, gain: 0.16, attack: 0.006, decay: 0.24 });
        }, i * 115);
      });
    },

    /** 任务成功 —— 明亮的大三和弦上行 */
    success() {
      // C-E-G-C(高) 的分解和弦，模拟通关号角
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => {
        setTimeout(() => {
          tone({ type: 'sine', freq: f, dur: 0.55, gain: 0.20, attack: 0.005, decay: 0.5 });
          tone({ type: 'triangle', freq: f * 2, dur: 0.4, gain: 0.05, attack: 0.005, decay: 0.38 });
        }, i * 145);
      });
      // 加上扬的"闪耀"尾音
      setTimeout(() => {
        tone({ type: 'sine', freq: 1318.5, dur: 0.9, gain: 0.11, attack: 0.02, decay: 0.85 });
      }, 590);
    },

    /** 全部检查点通过 */
    allCheckpoints() {
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
        setTimeout(() => tone({ type: 'sine', freq: f, dur: 0.3, gain: 0.17, attack: 0.004, decay: 0.28 }),
                 i * 78);
      });
    },

    /** 失速进入瞬间 */
    stallEnter() {
      // 经典的"失速钟"：急促的上下摆动
      tone({ type: 'sine', freq: 820, freq2: 420, dur: 0.4, gain: 0.20, attack: 0.01, decay: 0.36 });
      noise({ dur: 0.5, gain: 0.10, type: 'bandpass', freq: 1100, freq2: 500, q: 2.2, attack: 0.02 });
    },

    /** 超速警告进入 */
    overspeed() {
      tone({ type: 'square', freq: 1200, freq2: 1200, dur: 0.13, gain: 0.11, attack: 0.003, decay: 0.12 });
      tone({ type: 'square', freq: 1600, dur: 0.1, gain: 0.07, attack: 0.003, decay: 0.09 });
    },

    /** 提示音（toast，如"下一个检查点"） */
    hint() {
      tone({ type: 'sine', freq: 880, dur: 0.11, gain: 0.09, attack: 0.003, decay: 0.1 });
      tone({ type: 'sine', freq: 1174.7, dur: 0.09, gain: 0.055, attack: 0.003, decay: 0.08 });
    },

    /** 重新开始 */
    restart() {
      tone({ type: 'triangle', freq: 523.25, freq2: 784, dur: 0.2, gain: 0.14, attack: 0.004, decay: 0.19 });
    },
  };

  /** 统一的事件触发入口 */
  function play(name, arg) {
    if (!ctx || muted) return;
    if (ctx.state === 'suspended') ctx.resume();
    const fn = EVENTS[name];
    if (fn) fn(arg);
  }

  // ================= 3. 循环警报 =================
  function startAlarm(kind) {
    if (!ctx || muted || !unlocked) return;
    if (alarm[kind]) return;                 // 已在响
    const t = now();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === 'overspeed' ? 'square' : 'sine';
    const f = kind === 'stall' ? 760 : 1250;
    osc.frequency.value = f;
    gain.gain.value = 0.0001;
    osc.connect(gain); gain.connect(sfxBus);
    osc.start();
    alarm[kind] = { osc, gain, timer: 0, baseFreq: f };
    beep(kind);
  }

  function stopAlarm(kind) {
    const a = alarm[kind];
    if (!a) return;
    clearTimeout(a.timer);
    alarm[kind] = null;
    try {
      const t = now();
      a.gain.gain.cancelScheduledValues(t);
      a.gain.gain.setTargetAtTime(0.0001, t, 0.05);
      a.osc.stop(t + 0.25);
    } catch (e) { /* 已停止 */ }
  }

  /** 警报的断续"哔—哔—"节奏 */
  function beep(kind) {
    const a = alarm[kind];
    if (!a || !ctx) return;
    const t = now();
    const vol = kind === 'stall' ? 0.16 : 0.10;
    a.gain.gain.cancelScheduledValues(t);
    a.gain.gain.setValueAtTime(0.0001, t);
    a.gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    a.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    a.timer = setTimeout(() => beep(kind), 430);
  }

  // ================= 4. 每帧驱动警报状态 =================
  let wasStall = false, wasOverspeed = false;

  function updateAlerts(s) {
    if (!ctx || !unlocked) return;

    // 失速警报
    const isStall = s.stall === true;
    if (isStall && !wasStall) { EVENTS.stallEnter(); startAlarm('stall'); }
    if (!isStall && wasStall) stopAlarm('stall');
    wasStall = isStall;

    // 超速警报
    const isOver = s.kmh > 756;
    if (isOver && !wasOverspeed) { EVENTS.overspeed(); startAlarm('overspeed'); }
    if (!isOver && wasOverspeed) stopAlarm('overspeed');
    wasOverspeed = isOver;
  }

  // ================= 5. 音量控制 =================
  function setMuted(v) {
    muted = !!v;
    if (master) {
      master.gain.setTargetAtTime(muted ? 0.0001 : volume, now(), 0.05);
    }
    if (muted) {
      ['stall', 'overspeed'].forEach(stopAlarm);
    }
    return muted;
  }
  function toggleMute() { return setMuted(!muted); }

  function setVolume(v) {
    volume = clamp(v, 0, 1);
    if (master && !muted) master.gain.setTargetAtTime(volume, now(), 0.05);
  }

  function isMuted() { return muted; }

  // ================= 6. 页面隐藏时静音 =================
  // 切到别的标签页时继续响引擎声会很烦人
  let onVisibility = null;
  function bindVisibility() {
    if (typeof document === 'undefined' || onVisibility) return;
    onVisibility = () => {
      if (document.hidden) {
        if (master) master.gain.setTargetAtTime(0.0001, now(), 0.08);
      } else if (master && !muted) {
        master.gain.setTargetAtTime(volume, now(), 0.15);
        if (ctx && ctx.state === 'suspended') ctx.resume();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
  }

  // ================= 导出 =================
  return {
    unlock,
    bindVisibility,
    /** 每帧调用：驱动持续音与警报 */
    update(s) { setEngine(s); updateAlerts(s); },
    /** 事件音效 */
    play,
    silenceEngine,
    resumeEngine,
    setMuted,
    toggleMute,
    isMuted,
    setVolume,
    get ready() { return !!ctx && unlocked; },
  };
}
