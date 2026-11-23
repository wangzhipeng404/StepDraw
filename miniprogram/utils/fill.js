// 一笔一笔 StepDraw - 漫水填充（油漆桶）
// 与 web 端 utils/canvas.ts 的 floodFill 同构。
//
// 图案/用户画的封闭区域由抗锯齿线条围成。手画的圆几乎必然有 ≤2px 的起收笔
// 缺口，严格逐像素 flood fill 会从缺口漏出去、撞到画布边缘而误报"不封闭"。
// 所以这里：
//  1) 用 alpha 通道判定"墙"（墨线），不靠颜色容差对比；
//  2) 对墙做 1 像素二值膨胀，把 ≤2px 的缺口自动弥合（只用于遍历防漏）；
//  3) 墙内做 flood fill，碰到画布边缘 = 真的不封闭；
//  4) 输出时把区域向外扩 1px（只到抗锯齿 halo，不盖线条实体像素），
//     消掉填充与线条之间的白色缝隙。
// 结果是"区域掩码"（区域白色 alpha=255、区域外全透明），与颜色解耦：
// 再次喷涂同一区域复用同一份掩码、只换颜色，撤销时逐层退回上一个颜色。

// 墙的 alpha 阈值：≥ 该值算墨线实体。抗锯齿 halo 分两层：
//  - 内层 halo（alpha ≥ 100）算墙实体，视觉上已是线条边缘；
//  - 外层 halo（alpha < 100）近乎透明，不填会透出白底形成"白缝"，输出时补上。
const WALL_ALPHA = 100;
// 墙膨胀半径（像素）：手画线条缺口通常 ≤2px，膨胀 1px 即可把两侧墙接上；
// 太大反而会把细区域填死。
const WALL_DILATE = 1;

// 二值化墙图：alpha ≥ WALL_ALPHA 为 1（墨线实体）
function binarizeWall(src) {
  const n = src.width * src.height;
  const wall = new Uint8Array(n);
  const sd = src.data;
  for (let i = 0; i < n; i++) wall[i] = sd[i * 4 + 3] >= WALL_ALPHA ? 1 : 0;
  return wall;
}

// 对二值墙图做 box 膨胀（每个 3x3 邻域有墙即成墙），r 次
function dilateWall(wall, w, h, r) {
  let prev = wall;
  let cur = new Uint8Array(w * h);
  for (let k = 0; k < r; k++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (prev[i]) { cur[i] = 1; continue; }
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (prev[yy * w + xx]) { hit = 1; break; }
          }
        }
        cur[i] = hit ? 1 : 0;
      }
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev;
}

/**
 * 在 underlay（墨线合成图，透明底）上漫水填充，返回白色区域掩码。
 * @param {Canvas} underlay 当前墨线合成图（线条墙）
 * @param {number} seedX 种子点 x（underlay 像素坐标）
 * @param {number} seedY 种子点 y
 * @param {Function} makeCanvas 返回与 underlay 同尺寸的离屏画布（输出掩码用）
 * @returns {{ok:true, canvas:Canvas}|{ok:false, reason:'border'|'online'|'oob'}}
 *   border=区域不封闭（颜色会流到画布边缘）
 *   online=点在了线条上
 *   oob=落点越界
 */
function floodFill(underlay, seedX, seedY, makeCanvas) {
  const w = underlay.width;
  const h = underlay.height;
  const src = underlay.getContext('2d');
  if (!src || w === 0 || h === 0) return { ok: false, reason: 'oob' };

  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { ok: false, reason: 'oob' };

  const baseWall = binarizeWall(src.getImageData(0, 0, w, h));
  const wall = dilateWall(baseWall, w, h, WALL_DILATE);

  // 种子本身就在墙上（点在了线条上）：无处可填
  if (wall[sy * w + sx]) return { ok: false, reason: 'online' };

  // 只遍历"非墙"像素做连通域，墙即天然边界
  const visited = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  let touchesBorder = false;

  while (stack.length > 0) {
    const p = stack.pop();
    if (visited[p] || wall[p]) continue;
    visited[p] = 1;
    const x = p % w;
    const y = (p - x) / w;
    // 连通域碰到画布边缘 = 填的是"图案外的无限背景"，说明该处不封闭。
    // 图案居中且四周留 10% 边距，正常封闭区域绝不会碰到边缘，可提前终止。
    if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
      touchesBorder = true;
      break;
    }
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }

  if (touchesBorder) return { ok: false, reason: 'border' };

  // 输出：区域掩码（白色 alpha=255、区域外全透明），与颜色解耦。
  // 连通域 + 1px 外扩，但不覆盖线条实体像素（baseWall）。
  // 外扩盖住线条的抗锯齿 halo——膨胀墙让 visited 离线条多了 1px，
  // 不补的话 halo 下透出白底形成白缝。渲染时按 (mask, color) 上色。
  const out = makeCanvas();
  const outCtx = out.getContext('2d');
  const outData = outCtx.createImageData(w, h);
  const od = outData.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (baseWall[p]) continue;
      let hit = visited[p];
      if (!hit) {
        if ((x > 0 && visited[p - 1]) || (x < w - 1 && visited[p + 1]) ||
            (y > 0 && visited[p - w]) || (y < h - 1 && visited[p + w])) {
          hit = 1;
        }
      }
      if (!hit) continue;
      const i = p * 4;
      od[i] = 255; od[i + 1] = 255; od[i + 2] = 255; od[i + 3] = 255;
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return { ok: true, canvas: out };
}

// 判断点 (x,y)（掩码像素坐标）是否落在某区域掩码内。
// 用于"再次喷涂同区域时复用旧掩码"的判定。
function isPointInMask(mask, x, y) {
  const w = mask.width, h = mask.height;
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return false;
  const ctx = mask.getContext('2d');
  if (!ctx) return false;
  return ctx.getImageData(ix, iy, 1, 1).data[3] >= 128;
}

// 把白色区域掩码按颜色上色（掩码白色处 -> 颜色，其余透明），返回新画布。
// 颜色与区域解耦：改色只是换颜色，不重算区域。
function tintMask(mask, color, makeCanvas) {
  const w = mask.width, h = mask.height;
  const out = makeCanvas();
  const outCtx = out.getContext('2d');
  const srcCtx = mask.getContext('2d');
  if (!outCtx || !srcCtx) return out;
  const src = srcCtx.getImageData(0, 0, w, h).data;
  const outData = outCtx.createImageData(w, h);
  const od = outData.data;
  const fr = parseInt(color.slice(1, 3), 16);
  const fg = parseInt(color.slice(3, 5), 16);
  const fb = parseInt(color.slice(5, 7), 16);
  for (let i = 0; i < w * h; i++) {
    if (src[i * 4 + 3] < 128) continue;
    const j = i * 4;
    od[j] = fr; od[j + 1] = fg; od[j + 2] = fb; od[j + 3] = 255;
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

module.exports = { floodFill, isPointInMask, tintMask };
