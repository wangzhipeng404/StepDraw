// 一笔一笔 StepDraw - 漫水填充（油漆桶）
// 与 web 端 utils/canvas.ts 的 floodFill 同构。
//
// 图案/用户画的封闭区域由抗锯齿线条围成。手画的圆几乎必然有 ≤2px 的起收笔
// 缺口，严格逐像素 flood fill 会从缺口漏出去、撞到画布边缘而误报"不封闭"。
// 所以这里：
//  1) 用 alpha 通道判定"墙"（墨线），不靠颜色容差对比；
//  2) 对墙做 1 像素二值膨胀，把 ≤2px 的缺口自动弥合；
//  3) 墙内做 flood fill，碰到画布边缘 = 真的不封闭。
// 结果是一张与画布同尺寸、区域外全透明的位图，存进 UserFill.image。

// 墙的 alpha 阈值：≥ 该值算墨线
const WALL_ALPHA = 100;
// 墙膨胀半径（像素）
const WALL_DILATE = 1;

// 对二值墙图做 box 膨胀（每个 3x3 邻域有墙即成墙），r 次
function dilateWall(src, r) {
  const w = src.width, h = src.height;
  let prev = new Uint8Array(w * h);
  const sd = src.data;
  for (let i = 0; i < w * h; i++) prev[i] = sd[i * 4 + 3] >= WALL_ALPHA ? 1 : 0;
  const cur = new Uint8Array(w * h);
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
    const tmp = prev; prev = cur;
  }
  return prev;
}

/**
 * 在 underlay（墨线合成图，透明底）上漫水填充。
 * @param {Canvas} underlay 当前墨线合成图（图案线条 + 用户内容）
 * @param {number} seedX 种子点 x（underlay 像素坐标）
 * @param {number} seedY 种子点 y
 * @param {string} color 填充色（#RRGGBB）
 * @param {Function} makeCanvas 返回与 underlay 同尺寸的离屏画布（输出位图用）
 * @returns {{ok:true, canvas:Canvas}|{ok:false, reason:'border'|'online'|'oob'}}
 *   border=区域不封闭（颜色会流到画布边缘）
 *   online=点在了线条上
 *   oob=落点越界
 */
function floodFill(underlay, seedX, seedY, color, makeCanvas) {
  const w = underlay.width;
  const h = underlay.height;
  const src = underlay.getContext('2d');
  if (!src || w === 0 || h === 0) return { ok: false, reason: 'oob' };

  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { ok: false, reason: 'oob' };

  const wall = dilateWall(src.getImageData(0, 0, w, h), WALL_DILATE);
  const fr = parseInt(color.slice(1, 3), 16);
  const fg = parseInt(color.slice(3, 5), 16);
  const fb = parseInt(color.slice(5, 7), 16);

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

  // 只输出被填充的像素（区域外全透明），一次 putImageData
  const out = makeCanvas();
  const outCtx = out.getContext('2d');
  const outData = outCtx.createImageData(w, h);
  const od = outData.data;
  for (let p = 0; p < visited.length; p++) {
    if (!visited[p]) continue;
    const i = p * 4;
    od[i] = fr; od[i + 1] = fg; od[i + 2] = fb; od[i + 3] = 255;
  }
  outCtx.putImageData(outData, 0, 0);
  return { ok: true, canvas: out };
}

module.exports = { floodFill };
