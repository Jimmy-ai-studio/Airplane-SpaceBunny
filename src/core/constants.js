/**
 * 全局共享契约 —— 所有模块唯一数据源。
 * 坐标：右手系，Y 轴向上，单位 = 米。跑道沿 Z 轴延伸。
 * 飞机机头默认朝向 +Z。
 */

// ---------- 世界尺度 ----------
export const WORLD = {
  // 跑道：x=0 中心线，z ∈ [-RUNWAY_LEN/2, +RUNWAY_LEN/2]
  runwayLength: 3000,
  runwayWidth: 60,
  runwayY: 0,          // 跑道面标高
  thresholdZ: -1500,   // 起飞跑道头（南端）
  // 起飞朝向：+Z。着陆允许双向（±Z）
  groundSize: 26000,   // 地形平面边长
  seaLevel: 0,
  // 空域边界（超出即判定飞出空域）
  boundX: 11000,
  boundZMin: -4000,
  boundZMax: 16000,
  ceiling: 3000,
};

// ---------- 检查点（顺序固定，环平面法线 = 飞行通过方向） ----------
// 位置 / 半径 / 建议穿越速度 / 建议穿越高度
// 设计说明：三个环沿「起飞 → 右转 → 左转返场」排列，转向幅度刻意平缓
//（CP1→CP2 约 30°，CP2→CP3 约 90° 大转弯但航程充足），保证新手可完成。
export const CHECKPOINTS = [
  { id: 1, pos: [0,    300, 1150], radius: 110, normal: [0, 0, 1],   label: '起飞后爬升穿越' },
  { id: 2, pos: [900,  420, 2450], radius: 120, normal: [-0.30, 0, 0.95], label: '右转后斜穿' },
  { id: 3, pos: [-300, 360, 3450], radius: 120, normal: [0.45, 0, 0.89], label: '左转返场前' },
];
// 两次通过同一环的最小合法时间间隔（秒），防脚本刷分
export const CP_MIN_GAP = 1.5;

// ---------- 飞行器物理（SI 单位，量级贴近真实窄体客机） ----------
export const PHYS = {
  mass: 75000,            // kg
  wingArea: 190,          // m^2
  rho: 1.225,             // 空气密度
  g: 9.81,
  maxThrust: 320000,      // N，双发满推
  CL0: 0.30,
  CLalpha: 5.2,           // 每弧度
  stallAngle: 0.32,       // 约 18.3°，超过则升力骤降
  // α 保护（对应真实空客 FBW 迎角限制保护）：超过此迎角开始强制压杆
  alphaProtect: 0.26,
  alphaProtectGain: 2.5,  // 压杆强度（1/s 指令量）
  CD0: 0.022,
  // 诱导阻力系数（1/(pi·AR·e) 量级，AR≈10、e≈0.8）
  kInduced: 0.04,
  // 高速附加阻力（游戏化速度阻尼），CD += cdHi * (V/100)^2 + cdQuart * (V/100)^4
  // 二次项限制平飞终端速度，四次项限制俯冲极速（避免 1000+ km/h）
  cdHi: 0.030,
  cdQuart: 0.006,
  gLimit: 4.5,             // 最大过载，过大时柔和截断
  sideForceSlip: 0.18,      // 侧滑阻尼斜率（垂直尾翼侧力，量级 0.1~0.3 /rad）

  // ---- 气动静稳定性（让飞机真正「可飞」）----
  // 真实飞机尾翼产生的配平力矩，使飞机倾向于回到「航迹角 + 配平迎角」的姿态。
  // 缺了这一项，飞机松杆后会持续俯冲/掉高度，无法配平。
  trimAlpha: 0.055,        // 配平迎角（rad，约 3.2°）
  pitchStability: 1.7,     // 俯仰静稳定性增益 (1/s)
  pitchDamp: 0.55,         // 俯仰阻尼（抑制长周期振荡）
  rollLeveling: 0.9,       // 松杆自动回平增益
  rollLevelTau: 0.55,       // 自动回平时间常数
  yawStability: 1.1,       // 风标稳定性（消除侧滑）
  flapCL: 0.55,            // 襟翼全放额外升力系数
  flapCD: 0.045,           // 襟翼全放额外阻力系数
  flapSpeedMin: 40,        // m/s，超过此速度襟翼自动放出
  // 扰流器/空中减速板
  spoilerCD: 0.18,
  spoilerCLoss: 0.30,     // 减速板打开时升力损失比例
  // 姿态角速度目标值（rad/s）与响应时间常数（s）—— 保证有惯性，不会瞬转
  pitchRate: 0.95,
  rollRate: 2.10,
  yawRate: 0.38,
  pitchTau: 0.28,
  rollTau: 0.16,
  yawTau: 0.34,
  throttleRate: 0.55,      // 油门每秒变化量
  // 地面
  gearHeight: 2.8,          // 机身原点离地高度（轮子触地时）
  groundFriction: 0.022,     // 滚动阻力系数
  brakeDecel: 3.4,           // 刹车最大减速度 m/s²
  maxSteerRate: 0.62,        // 地面最大转向角速度 rad/s
  groundYawTau: 0.20,
  maxGroundPitch: 0.245,     // 地面抬轮上限（尾撑限制，约 14°，需足够迎角产生升力）
  // 接地判定阈值
  // 下沉率 1.8 m/s：真实 A320 硬着陆判据约 2~3 m/s，这里留出余量但仍能拦住摔机
  touchdownMaxSink: 1.8,
  touchdownMaxSpeed: 80,     // 接地水平速度 m/s（288 km/h）
  goodLandingSpeed: 68,      // 优秀着陆参考值 m/s
  touchdownMaxBankDeg: 12,
  touchdownMaxPitchDeg: 9,
  touchdownMaxYawDeg: 25,
  runwayPadZ: 250,           // 跑道两端外延缓冲区
  stopSpeed: 0.8,            // 判定滑行停止的速度
  timeLimit: 600,            // 秒，超时失败
  subStep: 1 / 200,          // 物理子步长，保证积分稳定
  // Vne（never exceed speed）：超过此速度进入超速警告区
  // 真实窄体客机 Vne 约 350 kt ≈ 180 m/s，这里放宽到 210 m/s(756 km/h)便于游戏
  vne: 210,
  vneWarn: 190,
  // 大坡度自动协调（FBW 协调功能）：
  // 坡度超过 BANK_COORD_RAD(35°) 后自动加抬头量，避免「压坡度忘拉杆」掉高度坠机
  bankCoordGain: 0.30,
};

// ---------- 视觉统一调色板（黄昏晴空，低多边形 flat 风格） ----------
export const PALETTE = {
  skyTop: 0x2f5f9e,
  skyHorizon: 0xf0b46a,
  sunColor: 0xfff2d0,
  hemiSky: 0x9dc4ea,
  hemiGround: 0x6b5a3e,
  fog: 0xd9c39a,
  ground: 0x7fa05a,
  groundAlt: 0x6d8f4e,
  mountain: 0x5f7a58,
  water: 0x2f6f8f,
  runway: 0x3a3f45,
  runwayEdge: 0xe8e8e8,
  markWhite: 0xf2f2f2,
  markYellow: 0xf0c24a,
  taxiway: 0x4a5058,
  buildingWall: 0xc9c3b6,
  buildingRoof: 0x8c6a4a,
  buildingGlass: 0x5d7f96,
  cityFar: 0x8e9aa8,
  skybridge: 0x3b4a5a,
  aircraftBody: 0xf2f4f7,
  aircraftAccent: 0x1f5fb0,
  aircraftAccent2: 0xf07a1a,
  aircraftDark: 0x2a2f36,
  aircraftGlass: 0x2c3a4a,
  engine: 0x6e747c,
  cpActive: 0xffc93c,
  cpNext: 0x4ce6a6,
  cpDone: 0x63d68a,
  navLeft: 0xff2d2d,
  navRight: 0x2dff6a,
};

// ---------- 相机 ----------
export const CAM = {
  fovBase: 58,
  fovMax: 74,
  dist: 26,
  height: 8.5,
  lookAhead: 42,
  posTau: 0.30,     // 位置平滑时间常数
  lookTau: 0.18,
  groundHeight: 4.5,
};

// ---------- 状态机 ----------
export const PHASE = {
  MENU: 'menu',
  READY: 'ready',     // 跑道上待起飞
  FLYING: 'flying',
  LANDED: 'landed',   // 已接地滑行
  SUCCESS: 'success',
  FAILED: 'failed',
};

// ---------- 失败原因文案 ----------
export const FAIL_REASON = {
  CRASH_GROUND: '撞地解体',
  CRASH_BUILDING: '撞上建筑物',
  STALL: '失速坠毁',
  HARD_LANDING: '重着陆 —— 接地冲击过大',
  TOO_FAST: '接地速度过高，未及减速',
  BAD_ATTITUDE: '接地姿态不稳（坡度/俯仰/偏航超限）',
  OFF_RUNWAY: '落在跑道之外',
  OVERRUN: '冲出跑道尽头',
  BOUNDARY: '飞出管制空域',
  CEILING: '超出升限',
  TIMEOUT: '超时未完成航程',
};
