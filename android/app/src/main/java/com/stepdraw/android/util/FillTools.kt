package com.stepdraw.android.util

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import kotlin.math.hypot

/**
 * 漫水填充 / 套索填充 / 墙判定 —— 与 web/utils/canvas.ts 的 floodFill / lassoFill /
 * binarizeWall / dilateWall 同构。
 *
 * 坐标约定：输入 underlay 与输出 mask 都在「层空间」（layerWidth×layerHeight，renderScale
 * 已应用、视图变换未叠加）。underlay 由调用方用 applyContentTransform(fit, IDENTITY) 画出
 * 可见线条合成图，所以直接在本空间 flood；得到的 mask 也是本空间位图，渲染时按视图变换 blit。
 */

// 墙的 alpha 阈值：≥ 该值算墨线实体（抗锯齿 halo 分两层，与 web 一致）
private const val WALL_ALPHA = 100
// 墙膨胀半径（层像素）：弥合 ≤2px 的线条缺口（手画圆几乎必然有起收笔缺口）
private const val WALL_DILATE = 1

/** 填充结果：Ok 带区域掩码（层空间，255=区域内）；Fail 带原因。 */
sealed class FillResult {
    class Ok(val mask: ByteArray, val w: Int, val h: Int) : FillResult()
    class Fail(val reason: String) : FillResult()   // border=不封闭 / online=点在墨线上 / oob=越界 / empty / nothing
}

/** 把像素 alpha 通道二值化成墙（1=墨线实体） */
private fun binarizeWall(pixels: IntArray, w: Int, h: Int): ByteArray {
    val wall = ByteArray(w * h)
    for (i in pixels.indices) wall[i] = if (Color.alpha(pixels[i]) >= WALL_ALPHA) 1 else 0
    return wall
}

/** 对二值墙做 box 膨胀（3×3 邻域有墙即成墙）r 次 */
private fun dilateWall(wall: ByteArray, w: Int, h: Int, r: Int): ByteArray {
    var prev = wall
    var cur = ByteArray(w * h)
    repeat(r) {
        for (y in 0 until h) {
            for (x in 0 until w) {
                val i = y * w + x
                if (prev[i] == 1.toByte()) { cur[i] = 1; continue }
                var hit = 0.toByte()
                outer@ for (dy in -1..1) {
                    val yy = y + dy
                    if (yy < 0 || yy >= h) continue
                    for (dx in -1..1) {
                        val xx = x + dx
                        if (xx < 0 || xx >= w) continue
                        if (prev[yy * w + xx] == 1.toByte()) { hit = 1; break@outer }
                    }
                }
                cur[i] = hit
            }
        }
        val tmp = prev; prev = cur; cur = tmp
    }
    return prev
}

/**
 * 漫水填充（油漆桶）。[underlay] 为可见线条合成图（层空间，透明底），[seedX]/[seedY] 落点（层像素）。
 * 成功返回 Ok + 区域掩码（连通域 + 1px 外扩，不覆盖线条实体）。
 */
fun floodFill(underlay: Bitmap, seedX: Int, seedY: Int): FillResult {
    val w = underlay.width
    val h = underlay.height
    if (w <= 0 || h <= 0) return FillResult.Fail("oob")
    if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h) return FillResult.Fail("oob")

    val pixels = IntArray(w * h)
    underlay.getPixels(pixels, 0, w, 0, 0, w, h)
    val wall = dilateWall(binarizeWall(pixels, w, h), w, h, WALL_DILATE)

    // 种子在墙上（点在线条上）：无处可填
    if (wall[seedY * w + seedX] == 1.toByte()) return FillResult.Fail("online")

    // 只遍历"非墙"像素做连通域；碰到画布边缘 = 该处不封闭
    val visited = ByteArray(w * h)
    val stack = IntArray(w * h)
    var sp = 0
    stack[sp++] = seedY * w + seedX
    var touchesBorder = false
    while (sp > 0) {
        val p = stack[--sp]
        if (visited[p] == 1.toByte() || wall[p] == 1.toByte()) continue
        visited[p] = 1
        val x = p % w
        val y = p / w
        if (x == 0 || x == w - 1 || y == 0 || y == h - 1) { touchesBorder = true; break }
        if (x > 0) stack[sp++] = p - 1
        if (x < w - 1) stack[sp++] = p + 1
        if (y > 0) stack[sp++] = p - w
        if (y < h - 1) stack[sp++] = p + w
    }
    if (touchesBorder) return FillResult.Fail("border")

    // 输出掩码：连通域 + 1px 外扩，但不覆盖线条实体像素（baseWall，避免盖住线条）
    val baseWall = binarizeWall(pixels, w, h)
    val mask = ByteArray(w * h)
    for (y in 0 until h) {
        for (x in 0 until w) {
            val p = y * w + x
            if (baseWall[p] == 1.toByte()) continue
            var hit = visited[p] == 1.toByte()
            if (!hit) {
                hit = (x > 0 && visited[p - 1] == 1.toByte()) ||
                    (x < w - 1 && visited[p + 1] == 1.toByte()) ||
                    (y > 0 && visited[p - w] == 1.toByte()) ||
                    (y < h - 1 && visited[p + w] == 1.toByte())
            }
            if (hit) mask[p] = 255
        }
    }
    return FillResult.Ok(mask, w, h)
}

/** 掩码（字节数组，255=区域内）转成白色位图，供渲染 blit */
fun maskToBitmap(mask: ByteArray, w: Int, h: Int): Bitmap {
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val px = IntArray(w * h)
    for (i in mask.indices) px[i] = if (mask[i] == 255.toByte()) 0xFFFFFFFF.toInt() else 0
    bmp.setPixels(px, 0, w, 0, 0, w, h)
    return bmp
}

/** 判断层空间点 (x,y) 是否在掩码内 */
fun isPointInMask(mask: ByteArray, w: Int, x: Int, y: Int): Boolean {
    if (x < 0 || y < 0 || x >= w) return false
    val i = y * w + x
    return i in mask.indices && mask[i] == 255.toByte()
}

/**
 * 套索填充：圈一圈，填"套索内且被线条完全封闭"的区域。
 * 掩码 = 套索内 && 非墙 && 非外部（外部 = 非墙且与画布边缘连通的开放区域）。
 */
fun lassoFill(underlay: Bitmap, points: List<PointF>): FillResult {
    val w = underlay.width
    val h = underlay.height
    if (w <= 0 || h <= 0) return FillResult.Fail("oob")
    if (points.size < 3) return FillResult.Fail("empty")

    val pixels = IntArray(w * h)
    underlay.getPixels(pixels, 0, w, 0, 0, w, h)
    val wall = dilateWall(binarizeWall(pixels, w, h), w, h, WALL_DILATE)
    val baseWall = binarizeWall(pixels, w, h)

    // 1) 套索内位图：实心填充套索多边形，采样 alpha
    val lassoBmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    Canvas(lassoBmp).apply {
        drawColor(Color.TRANSPARENT, android.graphics.PorterDuff.Mode.CLEAR)
        val lp = Path().apply {
            moveTo(points[0].x, points[0].y)
            for (i in 1 until points.size) lineTo(points[i].x, points[i].y)
            close()
        }
        drawPath(lp, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL })
    }
    val lassoPx = IntArray(w * h)
    lassoBmp.getPixels(lassoPx, 0, w, 0, 0, w, h)
    lassoBmp.recycle()
    val inLasso = ByteArray(w * h)
    var lassoCount = 0
    for (i in lassoPx.indices) {
        inLasso[i] = if (Color.alpha(lassoPx[i]) > 0) 1 else 0
        if (inLasso[i] == 1.toByte()) lassoCount++
    }
    if (lassoCount == 0) return FillResult.Fail("empty")

    // 2) 从画布边缘 flood 出"外部"（非墙且与边缘连通的开放区域）
    val outside = ByteArray(w * h)
    val extStack = IntArray(w * h)
    var esp = 0
    for (x in 0 until w) for (y in intArrayOf(0, h - 1)) {
        val p = y * w + x
        if (wall[p] == 0.toByte() && outside[p] == 0.toByte()) { outside[p] = 1; extStack[esp++] = p }
    }
    for (y in 0 until h) for (x in intArrayOf(0, w - 1)) {
        val p = y * w + x
        if (wall[p] == 0.toByte() && outside[p] == 0.toByte()) { outside[p] = 1; extStack[esp++] = p }
    }
    while (esp > 0) {
        val p = extStack[--esp]
        val x = p % w; val y = p / w
        if (x > 0) { val q = p - 1; if (wall[q] == 0.toByte() && outside[q] == 0.toByte()) { outside[q] = 1; extStack[esp++] = q } }
        if (x < w - 1) { val q = p + 1; if (wall[q] == 0.toByte() && outside[q] == 0.toByte()) { outside[q] = 1; extStack[esp++] = q } }
        if (y > 0) { val q = p - w; if (wall[q] == 0.toByte() && outside[q] == 0.toByte()) { outside[q] = 1; extStack[esp++] = q } }
        if (y < h - 1) { val q = p + w; if (wall[q] == 0.toByte() && outside[q] == 0.toByte()) { outside[q] = 1; extStack[esp++] = q } }
    }

    // 3) 掩码 = 套索内 && 非墙 && 非外部
    val mask = ByteArray(w * h)
    var filled = 0
    for (i in mask.indices) {
        if (baseWall[i] == 1.toByte()) continue
        if (inLasso[i] != 1.toByte()) continue
        if (outside[i] == 1.toByte()) continue
        mask[i] = 255
        filled++
    }
    if (filled == 0) return FillResult.Fail("nothing")
    return FillResult.Ok(mask, w, h)
}

/** 点 (p) 到折线 pts 的最短距离（橡皮擦几何命中判定用） */
fun pointToPolylineDistance(p: PointF, pts: List<PointF>): Float {
    if (pts.isEmpty()) return Float.MAX_VALUE
    if (pts.size == 1) return hypot((p.x - pts[0].x).toDouble(), (p.y - pts[0].y).toDouble()).toFloat()
    var best = Float.MAX_VALUE
    for (i in 1 until pts.size) {
        val a = pts[i - 1]; val b = pts[i]
        val abx = b.x - a.x; val aby = b.y - a.y
        val len2 = abx * abx + aby * aby
        val t = if (len2 == 0f) 0f else (((p.x - a.x) * abx + (p.y - a.y) * aby) / len2).coerceIn(0f, 1f)
        val cx = a.x + t * abx; val cy = a.y + t * aby
        best = minOf(best, hypot((p.x - cx).toDouble(), (p.y - cy).toDouble()).toFloat())
    }
    return best
}
