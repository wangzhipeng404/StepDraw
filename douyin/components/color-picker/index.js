const PRESETS = [
  '#F44336', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5', '#2196F3',
  '#03A9F4', '#00BCD4', '#009688', '#4CAF50', '#8BC34A', '#CDDC39',
  '#FFEB3B', '#FFC107', '#FF9800', '#FF5722', '#795548', '#9E9E9E',
  '#607D8B', '#000000', '#FFFFFF'
];

/* ---------------- 颜色转换工具 ---------------- */

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

// HSV -> RGB，h: 0~360, s/v: 0~100
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100) / 100;
  v = clamp(v, 0, 100) / 100;

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

// RGB -> HSV
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  return {
    h,
    s: max === 0 ? 0 : (d / max) * 100,
    v: max * 100
  };
}

function rgbToHex(r, g, b) {
  const to = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0').toUpperCase();
  return '#' + to(r) + to(g) + to(b);
}

// 支持 #RGB / #RRGGBB / RGB / RRGGBB
function hexToRgb(hex) {
  if (!hex) return null;
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

/* ---------------- 组件 ---------------- */

Component({
  properties: {
    // 当前颜色，支持 #RGB / #RRGGBB
    value: {
      type: String,
      value: '#FF0000',
      observer(val) {
        const rgb = hexToRgb(val);
        if (!rgb) return;
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
        if (hex === this.data.hex) return; // 避免回环更新
        this._applyRgb(rgb, false);
      }
    },
    // 自定义预设色板
    presets: {
      type: Array,
      value: PRESETS
    }
  },

  data: {
    hue: 0,            // 0 ~ 360
    saturation: 100,   // 0 ~ 100
    brightness: 100,   // 0 ~ 100
    hex: '#FF0000',
    hexInput: 'FF0000',
    hueColor: '#FF0000' // 当前色相对应的纯色，用于 SV 面板渐变
  },

  lifetimes: {
    attached() {
      const rgb = hexToRgb(this.data.value) || { r: 255, g: 0, b: 0 };
      this._applyRgb(rgb, false);
      this._measure();
    }
  },

  methods: {
    /* ---------- 尺寸测量 ---------- */
    _measure() {
      return new Promise((resolve) => {
        const query = this.createSelectorQuery();
        query.select('.cp-sv').boundingClientRect();
        query.select('.cp-hue').boundingClientRect();
        query.exec((res) => {
          this._svRect = res[0] || null;
          this._hueRect = res[1] || null;
          resolve();
        });
      });
    },

    /* ---------- 对外：重新测量（面板从屏外滑入后调用） ---------- */
    measure() {
      this._svRect = null;
      this._hueRect = null;
      return this._measure();
    },

    /* ---------- 内部：由 RGB 应用 ---------- */
    _applyRgb(rgb, emit = true) {
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      const hueRgb = hsvToRgb(hsv.h, 100, 100);

      this.setData({
        hue: hsv.h,
        saturation: hsv.s,
        brightness: hsv.v,
        hex,
        hexInput: hex.slice(1),
        hueColor: rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b)
      });

      if (emit) {
        this.triggerEvent('change', {
          hex,
          rgb,
          hsv: { h: hsv.h, s: hsv.s, v: hsv.v }
        });
      }
    },

    /* ---------- 内部：由 HSV 应用 ---------- */
    _applyHsv(hue, saturation, brightness, eventName) {
      const rgb = hsvToRgb(hue, saturation, brightness);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      const hueRgb = hsvToRgb(hue, 100, 100);

      this.setData({
        hue,
        saturation,
        brightness,
        hex,
        hexInput: hex.slice(1),
        hueColor: rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b)
      });

      if (eventName) {
        this.triggerEvent(eventName, {
          hex,
          rgb,
          hsv: { h: hue, s: saturation, v: brightness }
        });
      }
    },

    /* ---------- SV 面板拖动 ---------- */
    onSvTouch(e) {
      const touch = e.touches && e.touches[0];
      if (!touch) return;

      const run = (rect) => {
        if (!rect) return;
        const x = clamp(touch.clientX - rect.left, 0, rect.width);
        const y = clamp(touch.clientY - rect.top, 0, rect.height);

        const saturation = (x / rect.width) * 100;
        const brightness = (1 - y / rect.height) * 100;

        this._applyHsv(this.data.hue, saturation, brightness, 'change');
      };

      if (!this._svRect) {
        this._measure().then(() => run(this._svRect));
      } else {
        run(this._svRect);
      }
    },

    /* ---------- 色相条拖动 ---------- */
    onHueTouch(e) {
      const touch = e.touches && e.touches[0];
      if (!touch) return;

      const run = (rect) => {
        if (!rect) return;
        const x = clamp(touch.clientX - rect.left, 0, rect.width);
        const hue = (x / rect.width) * 360;
        this._applyHsv(hue, this.data.saturation, this.data.brightness, 'change');
      };

      if (!this._hueRect) {
        this._measure().then(() => run(this._hueRect));
      } else {
        run(this._hueRect);
      }
    },

    /* ---------- HEX 输入 ---------- */
    onHexInput(e) {
      // 只保留十六进制字符
      const val = String(e.detail.value || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toUpperCase()
        .slice(0, 6);

      this.setData({ hexInput: val });

      if (val.length === 6 || val.length === 3) {
        const rgb = hexToRgb(val);
        if (rgb) this._applyRgb(rgb, true);
      }
    },

    onHexBlur() {
      // 失焦时若输入不合法，回退到当前颜色
      const rgb = hexToRgb(this.data.hexInput);
      if (rgb) {
        this._applyRgb(rgb, false);
      } else {
        this.setData({ hexInput: this.data.hex.slice(1) });
      }
    },

    /* ---------- 预设色点击 ---------- */
    onPresetTap(e) {
      const color = e.currentTarget.dataset.color;
      const rgb = hexToRgb(color);
      if (rgb) this._applyRgb(rgb, true);
    },

    /* ---------- 对外方法 ---------- */
    getColor() {
      const rgb = hexToRgb(this.data.hex);
      return {
        hex: this.data.hex,
        rgb,
        hsv: {
          h: this.data.hue,
          s: this.data.saturation,
          v: this.data.brightness
        }
      };
    },

    setColor(hex) {
      const rgb = hexToRgb(hex);
      if (rgb) this._applyRgb(rgb, false);
    }
  }
});