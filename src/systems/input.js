/**
 * 键盘输入 —— 油门/俯仰/横滚/偏航/刹车。
 * 油门为「保持型」：松开 W/S 后油门停在当前值，不会自动回中。
 */
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.axes = { pitch: 0, roll: 0, yaw: 0, throttleAxis: 0, brake: false };
    this._onKeyDown = (e) => {
      // 避免方向键/空格滚动页面
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      this.keys.add(e.code);
      this._sync();
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this._sync();
    };
    this._onBlur = () => { this.keys.clear(); this._sync(); };

    target.addEventListener('keydown', this._onKeyDown, { passive: false });
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    this._target = target;
  }

  _sync() {
    const k = this.keys;
    const a = this.axes;
    a.pitch = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    // 视觉一致：按右滚（→）飞机应向右倾（roll 减小），见 physics 中 roll 符号
    a.roll = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    a.yaw = (k.has('KeyA') ? 1 : 0) - (k.has('KeyD') ? 1 : 0);
    a.throttleAxis = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    a.brake = k.has('Space');
  }

  /** 读取一次性按键（用后即清） */
  consume(code) {
    if (this.keys.has(code)) { this.keys.delete(code); return true; }
    return false;
  }

  clear() { this.keys.clear(); this._sync(); }

  dispose() {
    const t = this._target;
    t.removeEventListener('keydown', this._onKeyDown);
    t.removeEventListener('keyup', this._onKeyUp);
    t.removeEventListener('blur', this._onBlur);
  }
}
