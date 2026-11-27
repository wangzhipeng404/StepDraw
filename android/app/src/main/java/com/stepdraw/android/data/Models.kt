package com.stepdraw.android.data

import android.graphics.PointF
import android.graphics.RectF
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.max

// ============================================================
// 数据模型（与 web/public/data 的 JSON 结构对齐，同 ipad/Models.swift）
// ============================================================

/** 一条笔画：一组采样点 + 线宽（cocomaterial 数据额外带 color 字段，保留） */
data class StrokeJSON(
    val width: Double,
    val color: String? = null,
    val points: List<List<Double>>,
) {
    val cgPoints: List<PointF> by lazy {
        points.mapNotNull { p ->
            if (p.size >= 2) PointF(p[0].toFloat(), p[1].toFloat()) else null
        }
    }
}

/** 一个步骤：多条笔画 + 文字提示 */
data class StepJSON(
    val id: Int? = null,
    val tip: String? = null,
    val strokes: List<StrokeJSON>,
)

/** 一幅图案 */
data class Drawing(
    val id: String,
    val name: String? = null,
    val tags: List<String>? = null,
    val difficulty: Int? = null,
    val viewBox: List<Double>? = null,
    val thumbnail: String? = null,
    val steps: List<StepJSON>,
) {
    val displayName: String
        get() = if (name.isNullOrBlank()) id else name

    /** 图案内容区域（内容坐标系） */
    val contentRect: RectF
        get() {
            val vb = viewBox
            if (vb == null || vb.size < 4 || vb[2] <= vb[0] || vb[3] <= vb[1]) {
                return RectF(0f, 0f, 256f, 256f)
            }
            return RectF(vb[0].toFloat(), vb[1].toFloat(), vb[2].toFloat(), vb[3].toFloat())
        }
}

// MARK: - 索引数据

data class MainGroup(val id: String, val name: String, val emoji: String? = null)

data class MainCategory(
    val id: String,
    val name: String? = null,
    val emoji: String? = null,
    val count: Int? = null,
    val dir: String? = null,
) {
    val displayName: String
        get() = if (name.isNullOrBlank()) id else name
}

data class MainIndex(
    val viewBox: List<Double>? = null,
    val groups: List<MainGroup>? = null,
    val categories: List<MainCategory>,
)

data class DrawingItem(
    val id: String,
    val name: String,
    val difficulty: Int? = null,
    val stepCount: Int? = null,
    val thumbnail: String? = null,
)

data class CategoryIndex(
    val category: String? = null,
    val name: String? = null,
    val viewBox: List<Double>? = null,
    val items: List<DrawingItem>,
)

// MARK: - 用户笔画

/** 绘图工具（与 web 的 STROKE_TYPES 一一对应，共 8 种） */
enum class Tool(val displayName: String, val isPaint: Boolean) {
    PEN("钢笔", true),
    PENCIL("铅笔", true),
    MARKER("马克笔", true),
    BRUSH("毛笔", true),
    FILL("填充", false),
    LASSOFILL("套索填充", false),
    ERASER("橡皮擦", false),
    COLORPICK("取色器", false),
}

/** 笔种（仅绘制类工具产生笔画；填充/套索/橡皮/取色不产生笔画） */
enum class BrushKind(val displayName: String) {
    PEN("钢笔"),
    PENCIL("铅笔"),
    MARKER("马克笔"),
    BRUSH("毛笔");
}

/** Tool -> BrushKind（非绘制工具无笔种） */
fun Tool.brushKindOrNull(): BrushKind? = when (this) {
    Tool.PEN -> BrushKind.PEN
    Tool.PENCIL -> BrushKind.PENCIL
    Tool.MARKER -> BrushKind.MARKER
    Tool.BRUSH -> BrushKind.BRUSH
    else -> null
}

/**
 * 用户的一笔（以内容坐标存储，缩放/平移只是显示层变换，不影响数据）。
 */
data class UserStroke(
    val points: MutableList<PointF> = mutableListOf(),
    val width: Float,
    val color: Int,
    val kind: BrushKind,
)

/**
 * 用户填充（油漆桶 / 套索）。mask 是「层空间」区域位图（255=区域内），
 * 与颜色解耦；渲染时按 mask 上色。层空间 = layerWidth×layerHeight（视图变换未叠加），
 * 渲染时按当前视图 blit，与引导/已完成线同坐标系。
 */
data class UserFill(
    val mask: ByteArray,
    val w: Int,
    val h: Int,
    val color: Int,
) {
    override fun equals(other: Any?) = other is UserFill && other.w == w && other.h == h && other.color == color && other.mask.contentEquals(mask)
    override fun hashCode(): Int { var h = mask.contentHashCode(); h = 31 * h + w; h = 31 * h + this.h; h = 31 * h + color; return h }
}

/** 用户操作（按时间序混排：笔画 + 填充）。撤销/擦除都基于此列表。 */
sealed class UserAction {
    data class Stroke(val stroke: UserStroke) : UserAction()
    data class Fill(val fill: UserFill) : UserAction()
}

/** 撤销增量：add 追加 / erase 按位删除 / clear 整体（撤销即逆操作，与 web 一致） */
sealed class UndoDelta {
    object Add : UndoDelta()
    data class Erase(val index: Int, val action: UserAction) : UndoDelta()
    data class Clear(val actions: List<UserAction>) : UndoDelta()
}

// ============================================================
// 视图变换（缩放 / 平移）—— 与 ipad/ViewTransform.swift 同构
//
// 内容坐标系：图案 viewBox 坐标。
// 适配变换（fit）：把 contentRect 等比缩放到画布（留 15% 边距）居中。
// 视图变换（view）：叠加在适配之上，以画布中心为缩放中心，用户手势产生。
//
// 层坐标 p' = C + t + s * (fit(p) - C)，C = 画布中心。
// 用户笔画以内容坐标存储，缩放/平移只是显示层变换，导出与复位不受影响。
// ============================================================

data class ViewTransform(val scale: Float, val tx: Float, val ty: Float) {
    companion object {
        val IDENTITY = ViewTransform(1f, 0f, 0f)
        const val MIN_SCALE = 0.3f
        const val MAX_SCALE = 5f
    }
}

fun clampScale(s: Float): Float = min(ViewTransform.MAX_SCALE, max(ViewTransform.MIN_SCALE, s))

/** 以画布中心为锚点缩放：给定锚点前的 scale 与平移，返回缩放后使锚点保持不动的平移 */
fun zoomAnchored(view: ViewTransform, newScale: Float, anchorX: Float, anchorY: Float): ViewTransform {
    val factor = newScale / view.scale
    return ViewTransform(
        scale = newScale,
        tx = anchorX - factor * (anchorX - view.tx),
        ty = anchorY - factor * (anchorY - view.ty),
    )
}

// MARK: - 视图变换

/** 尺寸（width/height 为 Float，与视图变换公式统一用浮点） */
data class Size(val width: Float, val height: Float) {
    constructor(width: Int, height: Int) : this(width.toFloat(), height.toFloat())
}

/** 把内容坐标点换算成层坐标点 */
fun toLayerPoint(
    p: PointF,
    size: Size,
    fit: FitTransform,
    view: ViewTransform,
): PointF {
    val c = PointF(size.width / 2f, size.height / 2f)
    val fitPx = p.x * fit.scale + fit.offsetX
    val fitPy = p.y * fit.scale + fit.offsetY
    return PointF(
        c.x + view.tx + view.scale * (fitPx - c.x),
        c.y + view.ty + view.scale * (fitPy - c.y),
    )
}

/** 把层坐标点（触点在 layer.bounds 内的坐标）换算回内容坐标 */
fun toImagePoint(
    p: PointF,
    size: Size,
    fit: FitTransform,
    view: ViewTransform,
): PointF {
    val c = PointF(size.width / 2f, size.height / 2f)
    val x = (p.x - c.x - view.tx) / view.scale + c.x
    val y = (p.y - c.y - view.ty) / view.scale + c.y
    return PointF((x - fit.offsetX) / fit.scale, (y - fit.offsetY) / fit.scale)
}

/** 图案内容在画布上的适配变换 */
data class FitTransform(val scale: Float, val offsetX: Float, val offsetY: Float)

fun fitTransform(size: Size, drawing: Drawing): FitTransform {
    val r = drawing.contentRect
    if (r.width() <= 0f || r.height() <= 0f) {
        return FitTransform(1f, 0f, 0f)
    }
    val margin = 0.85f
    val scale = min(
        size.width * margin / r.width(),
        size.height * margin / r.height(),
    )
    val offsetX = (size.width - r.width() * scale) / 2f - r.left * scale
    val offsetY = (size.height - r.height() * scale) / 2f - r.top * scale
    return FitTransform(scale, offsetX, offsetY)
}

// ============================================================
// 笔画几何
// ============================================================

/** 笔画总长度（采样折线长度，用于进度插值） */
fun strokeLength(points: List<PointF>): Float {
    if (points.size <= 1) return 0f
    var total = 0f
    for (i in 1 until points.size) {
        total += hypot(
            (points[i].x - points[i - 1].x).toDouble(),
            (points[i].y - points[i - 1].y).toDouble(),
        ).toFloat()
    }
    return total
}

// ============================================================
// 常用色板（与 web 端一致）
// ============================================================

val PALETTE: List<Int> = listOf(
    0xFFE53935.toInt(),
    0xFF1E88E5.toInt(),
    0xFF43A047.toInt(),
    0xFFFB8C00.toInt(),
    0xFF8E24AA.toInt(),
    0xFF000000.toInt(),
)
