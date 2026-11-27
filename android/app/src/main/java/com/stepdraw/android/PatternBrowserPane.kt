package com.stepdraw.android

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.AttributeSet
import android.util.TypedValue
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.stepdraw.android.data.DataStore
import com.stepdraw.android.data.DrawingItem
import com.stepdraw.android.data.MainCategory
import com.stepdraw.android.data.MainGroup
import com.stepdraw.android.data.MainIndex
import com.stepdraw.android.util.ImageLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 图案选中回调（由宿主 Activity 实现）
 */
interface PatternListener {
    fun onPatternSelected(categoryId: String, item: DrawingItem)
}

/** 浏览器页面栈中的三种页面（文件级，便于适配器引用） */
sealed class Page {
    data class GroupList(val groups: List<MainGroup>) : Page()
    data class CategoryList(val group: MainGroup, val categories: List<MainCategory>) : Page()
    data class Grid(
        val category: MainCategory,
        val items: List<DrawingItem>,
        val loadedCount: Int,
        val difficulty: Int,
        val query: String,
    ) : Page()
}

/**
 * 常驻图案浏览面板（分栏左栏）：分组 → 分类 → 图案网格（搜索/难度筛选/分页加载）。
 * 与 ipad/PatternBrowser.swift 同构，用单 RecyclerView + 页面栈模拟 NavigationStack。
 *
 * 与底部弹窗版的区别：这是常驻 View（非 DialogFragment），放在 activity 布局的左栏；
 * 选中图案后通过 [onSelect] 回调宿主载入右侧画布，面板停留在当前层级
 * （与 web 端分栏"点图案不跳转、直接载入右侧"的行为一致）。
 */
class PatternBrowserPane @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : LinearLayout(context, attrs) {

    var onSelect: ((String, DrawingItem) -> Unit)? = null
    /** 当前右侧画布图案 id（网格中高亮，宿主在图案变化时更新） */
    var currentDrawingId: String? = null

    private val pages = ArrayDeque<Page>()
    private lateinit var adapter: PaneAdapter
    private var gridItems: MutableList<DrawingItem> = mutableListOf()
    private var gridLoaded = 0
    private var gridLoading = false
    private var currentGridCategory: String? = null
    private var mainIndex: MainIndex? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val density: Float get() = resources.displayMetrics.density
    private fun dp(v: Int): Int = (v * density).toInt()

    // 头部控件
    private lateinit var btnBack: ImageButton
    private lateinit var tvTitle: TextView
    private lateinit var searchBox: EditText
    private lateinit var diffChips: LinearLayout
    private lateinit var diffButtons: Array<TextView>
    private lateinit var rv: RecyclerView
    private lateinit var progressView: ProgressBar
    private var errorShown = false

    companion object {
        private const val PAGE = 24
    }

    init {
        orientation = VERTICAL
        background = GradientDrawable().apply {
            setColor(Color.WHITE)
            cornerRadius = 0f
        }

        // ===== 头部 =====
        val header = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(10))
        }
        btnBack = ImageButton(context).apply {
            setImageResource(android.R.drawable.ic_menu_revert)
            setColorFilter(Color.parseColor("#8E8E93"))
            val p = dp(4)
            setPadding(p, p, p, p)
            background = null
            visibility = View.GONE
            setOnClickListener { popPage() }
        }
        tvTitle = TextView(context).apply {
            text = "选择图案"
            textSize = 16f
            setTextColor(Color.parseColor("#1C1C1E"))
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 1
        }
        searchBox = EditText(context).apply {
            hint = "搜索图案名称"
            textSize = 13f
            setSingleLine(true)
            visibility = View.GONE
            setPadding(dp(10), 0, dp(10), 0)
            background = GradientDrawable().apply {
                setColor(0xFFEDEDF2.toInt())
                cornerRadius = dp(8).toFloat()
            }
            setOnEditorActionListener { v, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_DONE) {
                    applySearch(v.text.toString())
                    true
                } else false
            }
        }
        header.addView(btnBack)
        header.addView(
            tvTitle,
            LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).also { it.marginStart = dp(8) },
        )
        header.addView(
            searchBox,
            LayoutParams(0, LayoutParams.WRAP_CONTENT, 1.4f).also { it.marginStart = dp(8) },
        )
        addView(
            header,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT),
        )

        // ===== 难度筛选（网格页显示）=====
        diffChips = LinearLayout(context).apply {
            orientation = HORIZONTAL
            visibility = View.GONE
        }
        val diffLabels = arrayOf("全部", "入门", "简单", "进阶")
        diffButtons = Array(4) { i ->
            TextView(context).apply {
                text = diffLabels[i]
                textSize = 12f
                setPadding(dp(10), dp(5), dp(10), dp(5))
                layoutParams = LayoutParams(
                    LayoutParams.WRAP_CONTENT,
                    LayoutParams.WRAP_CONTENT,
                ).also { it.marginStart = if (i == 0) 0 else dp(6) }
                setOnClickListener { applyDifficulty(i) }
            }
        }
        for (b in diffButtons) diffChips.addView(b)
        addView(
            diffChips,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
                .also { it.topMargin = dp(6); it.leftMargin = dp(14); it.rightMargin = dp(14) },
        )

        // ===== 列表区 =====
        rv = RecyclerView(context).apply {
            layoutManager = GridLayoutManager(context, 2)
            isVerticalScrollBarEnabled = true
        }
        addView(
            rv,
            LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f).also { it.topMargin = dp(6) },
        )

        progressView = ProgressBar(context).apply { visibility = View.VISIBLE }
        addView(
            progressView,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
                .also { it.topMargin = dp(10); it.gravity = Gravity.CENTER },
        )

        adapter = PaneAdapter(
            density = density,
            onGroupClick = { pushCategory(it) },
            onCategoryClick = { pushGrid(it) },
            onItemSelect = { item ->
                val cat = currentGridCategory ?: return@PaneAdapter
                onSelect?.invoke(cat, item)
            },
            onThumbBind = { view, item, catId ->
                ImageLoader.load(view, DataStore.getInstance().thumbnailURL(catId, item))
            },
            onReachEnd = { loadMore() },
        )
        rv.adapter = adapter

        // 首次加载分组
        scope.launch {
            try {
                val idx = DataStore.getInstance().loadMainIndex()
                mainIndex = idx
                pushGroupList(idx.groups ?: emptyList())
            } catch (e: Exception) {
                showError("加载分类失败，请检查网络后重试")
            }
        }
    }

    override fun onDetachedFromWindow() {
        scope.cancel()
        super.onDetachedFromWindow()
    }

    // MARK: - 页面栈

    private fun pushGroupList(groups: List<MainGroup>) {
        pages.clear()
        pages.addLast(Page.GroupList(groups))
        renderCurrentPage()
    }

    private fun pushCategory(group: MainGroup) {
        val idx = mainIndex ?: return
        val cats = idx.categories.filter {
            it.id == group.id || (it.dir ?: "").startsWith(group.id + "/")
        }
        // 只有一个分类且就是组本身（如 linedrawer）：直达图案网格，少一次点击（与 web Home 一致）
        if (cats.size == 1) {
            pushGrid(cats[0])
        } else {
            pages.addLast(Page.CategoryList(group, cats))
            renderCurrentPage()
        }
    }

    private fun pushGrid(cat: MainCategory) {
        gridItems.clear()
        gridLoaded = 0
        currentGridCategory = cat.id
        gridLoading = true
        progressView.visibility = View.VISIBLE
        pages.addLast(Page.Grid(cat, emptyList(), 0, 0, ""))
        renderCurrentPage()
        scope.launch {
            try {
                val catIndex = DataStore.getInstance().loadCategoryIndex(cat.id)
                gridItems = catIndex.items.toMutableList()
                gridLoaded = PAGE
                gridLoading = false
                if (pages.last() is Page.Grid && (pages.last() as Page.Grid).category.id == cat.id) {
                    (pages.last() as Page.Grid).let {
                        pages.removeLast()
                        pages.addLast(Page.Grid(cat, gridItems.toList(), gridLoaded, it.difficulty, it.query))
                    }
                    renderCurrentPage()
                }
            } catch (e: Exception) {
                gridLoading = false
                showError("加载图案列表失败，请检查网络后重试")
            }
            if (!gridLoading && pages.last() is Page.Grid) {
                progressView.visibility = View.GONE
            }
        }
    }

    private fun popPage() {
        if (pages.size > 1) {
            pages.removeLast()
            renderCurrentPage()
        }
    }

    private fun applySearch(q: String) {
        if (pages.last() is Page.Grid) {
            val g = pages.last() as Page.Grid
            pages.removeLast()
            pages.addLast(g.copy(query = q.trim()))
            renderCurrentPage()
            hideKeyboard()
        }
    }

    private fun applyDifficulty(d: Int) {
        if (pages.last() is Page.Grid) {
            val g = pages.last() as Page.Grid
            pages.removeLast()
            pages.addLast(g.copy(difficulty = d))
            renderCurrentPage()
            refreshDiffChips(d)
        }
    }

    private fun refreshDiffChips(selected: Int) {
        for (i in diffButtons.indices) {
            val b = diffButtons[i]
            val active = i == selected
            b.setTextColor(if (active) Color.WHITE else Color.parseColor("#1C1C1E"))
            b.background = GradientDrawable().apply {
                cornerRadius = 999f
                setColor(if (active) Color.parseColor("#1E88E5") else 0xFFEDEDF2.toInt())
            }
        }
    }

    private fun loadMore() {
        if (pages.last() !is Page.Grid) return
        if (gridLoaded >= gridItems.size) return
        gridLoaded = (gridLoaded + PAGE).coerceAtMost(gridItems.size)
        rv.post {
            if (!isAttachedToWindow) return@post
            val fresh = pages.last() as? Page.Grid ?: return@post
            val newPage = fresh.copy(loadedCount = gridLoaded)
            pages.removeLast()
            pages.addLast(newPage)
            adapter.submit(newPage, currentDrawingId)
        }
    }

    private fun showError(msg: String) {
        if (errorShown) return
        errorShown = true
        progressView.visibility = View.GONE
        tvTitle.text = msg
        btnBack.visibility = View.VISIBLE
        btnBack.setOnClickListener {
            errorShown = false
            tvTitle.text = "选择图案"
            btnBack.visibility = View.GONE
            progressView.visibility = View.VISIBLE
            scope.launch {
                try {
                    val idx = DataStore.getInstance().loadMainIndex(force = true)
                    mainIndex = idx
                    pushGroupList(idx.groups ?: emptyList())
                } catch (e: Exception) {
                    showError("加载分类失败，请检查网络后重试")
                }
            }
        }
    }

    private fun renderCurrentPage() {
        val page = pages.lastOrNull() ?: return
        progressView.visibility = if (gridLoading && page is Page.Grid) View.VISIBLE else View.GONE
        when (page) {
            is Page.GroupList -> {
                tvTitle.text = "选择图案"
                btnBack.visibility = View.GONE
                searchBox.visibility = View.GONE
                diffChips.visibility = View.GONE
                rv.layoutManager = GridLayoutManager(context, 2)
                adapter.submit(page, currentDrawingId)
            }

            is Page.CategoryList -> {
                tvTitle.text = page.group.name
                btnBack.visibility = View.VISIBLE
                searchBox.visibility = View.GONE
                diffChips.visibility = View.GONE
                rv.layoutManager = GridLayoutManager(context, 2)
                adapter.submit(page, currentDrawingId)
            }

            is Page.Grid -> {
                tvTitle.text = page.category.displayName
                btnBack.visibility = View.VISIBLE
                searchBox.visibility = View.VISIBLE
                diffChips.visibility = View.VISIBLE
                refreshDiffChips(page.difficulty)
                val span = if (rv.width > 0) {
                    (rv.width / dp(104)).coerceIn(2, 5)
                } else 2
                rv.layoutManager = GridLayoutManager(context, span)
                adapter.submit(page, currentDrawingId)
                searchBox.setText(page.query)
            }
        }
    }

    private fun hideKeyboard() {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE)
            as? android.view.inputmethod.InputMethodManager
        imm?.hideSoftInputFromWindow(searchBox.windowToken, 0)
    }
}

/**
 * 三态适配器：分组卡片 / 分类卡片 / 图案网格卡片。统一用一个 ViewHolder 承载所有子视图。
 */
private class PaneAdapter(
    private val density: Float,
    private val onGroupClick: (MainGroup) -> Unit,
    private val onCategoryClick: (MainCategory) -> Unit,
    private val onItemSelect: (DrawingItem) -> Unit,
    private val onThumbBind: (ImageView, DrawingItem, String) -> Unit,
    private val onReachEnd: () -> Unit,
) : RecyclerView.Adapter<PaneAdapter.Holder>() {

    private var page: Any? = null
    private var currentCategoryForGrid: MainCategory? = null
    private var currentDrawingId: String? = null

    fun submit(page: Any, currentDrawingId: String?) {
        this.page = page
        this.currentDrawingId = currentDrawingId
        currentCategoryForGrid = (page as? Page.Grid)?.category
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val ctx = parent.context
        fun dp(v: Int) = (v * density).toInt()

        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(8), dp(12), dp(8), dp(12))
            background = GradientDrawable().apply {
                setColor(0xFFEDEDF2.toInt())
                cornerRadius = dp(12).toFloat()
            }
            layoutParams = RecyclerView.LayoutParams(
                RecyclerView.LayoutParams.MATCH_PARENT,
                RecyclerView.LayoutParams.WRAP_CONTENT,
            ).also { it.setMargins(dp(6), dp(6), dp(6), dp(6)) }
        }
        val emoji = TextView(ctx).apply {
            textSize = 32f
            gravity = Gravity.CENTER
        }
        val title = TextView(ctx).apply {
            textSize = 14f
            setTextColor(Color.parseColor("#1C1C1E"))
            gravity = Gravity.CENTER
            maxLines = 1
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(4), 0, 0)
        }
        val subtitle = TextView(ctx).apply {
            textSize = 11f
            setTextColor(Color.parseColor("#8E8E93"))
            gravity = Gravity.CENTER
            maxLines = 1
            setPadding(0, dp(2), 0, 0)
        }
        val thumb = ImageView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(dp(88), dp(88))
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = GradientDrawable().apply {
                setColor(0xFFF5F5F7.toInt())
                cornerRadius = dp(8).toFloat()
            }
            setPadding(dp(4), dp(4), dp(4), dp(4))
        }
        val name = TextView(ctx).apply {
            textSize = 12f
            setTextColor(Color.parseColor("#1C1C1E"))
            maxLines = 1
            gravity = Gravity.CENTER
            setPadding(0, dp(4), 0, 0)
        }
        val diffTag = TextView(ctx).apply {
            textSize = 9f
            maxLines = 1
            setPadding(dp(6), dp(2), dp(6), dp(2))
        }
        card.addView(emoji)
        card.addView(title)
        card.addView(subtitle)
        card.addView(thumb)
        card.addView(name)
        card.addView(diffTag)
        return Holder(card, emoji, title, subtitle, thumb, name, diffTag)
    }

    override fun getItemCount(): Int {
        val p = page ?: return 0
        return when (p) {
            is Page.GroupList -> p.groups.size
            is Page.CategoryList -> p.categories.size
            is Page.Grid -> visibleCount(p)
            else -> 0
        }
    }

    private fun visibleCount(g: Page.Grid): Int {
        val base = g.items.take(g.loadedCount)
        val q = g.query
        val searched = if (q.isEmpty()) base else base.filter { it.name.contains(q, true) }
        return if (g.difficulty == 0) searched.size
        else searched.filter { (it.difficulty ?: 3) == g.difficulty }.size
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val p = page ?: return
        when (p) {
            is Page.GroupList -> {
                val group = p.groups[position]
                bindCard(
                    holder,
                    emoji = group.emoji ?: "📦",
                    title = group.name,
                    subtitle = "分类",
                    showThumb = false,
                    showName = false,
                )
                holder.itemView.setOnClickListener { onGroupClick(group) }
            }

            is Page.CategoryList -> {
                val cat = p.categories[position]
                bindCard(
                    holder,
                    emoji = cat.emoji ?: "📦",
                    title = cat.displayName,
                    subtitle = "${cat.count ?: 0} 个",
                    showThumb = false,
                    showName = false,
                )
                holder.itemView.setOnClickListener { onCategoryClick(cat) }
            }

            is Page.Grid -> {
                val item = resolveGridItem(p, position)
                bindCard(
                    holder,
                    emoji = null,
                    title = null,
                    subtitle = null,
                    showThumb = true,
                    showName = true,
                    name = item.name,
                    difficulty = item.difficulty,
                    thumbItem = item,
                    selected = item.id == currentDrawingId,
                )
                holder.itemView.setOnClickListener { onItemSelect(item) }
                if (position >= visibleCount(p) - 6) onReachEnd()
            }
        }
    }

    private fun resolveGridItem(g: Page.Grid, position: Int): DrawingItem {
        val base = g.items.take(g.loadedCount)
        val q = g.query
        val searched = if (q.isEmpty()) base else base.filter { it.name.contains(q, true) }
        val filtered = if (g.difficulty == 0) searched
        else searched.filter { (it.difficulty ?: 3) == g.difficulty }
        return filtered.getOrElse(position) { base.getOrElse(position) { g.items.firstOrNull() ?: DrawingItem("", "") } }
    }

    private fun bindCard(
        h: Holder,
        emoji: String?,
        title: String?,
        subtitle: String?,
        showThumb: Boolean,
        showName: Boolean,
        name: String? = null,
        difficulty: Int? = null,
        thumbItem: DrawingItem? = null,
        selected: Boolean = false,
    ) {
        h.emoji.visibility = if (emoji != null) View.VISIBLE else View.GONE
        if (emoji != null) h.emoji.text = emoji
        h.title.visibility = if (title != null) View.VISIBLE else View.GONE
        if (title != null) h.title.text = title
        h.subtitle.visibility = if (subtitle != null) View.VISIBLE else View.GONE
        if (subtitle != null) h.subtitle.text = subtitle
        h.thumb.visibility = if (showThumb) View.VISIBLE else View.GONE
        h.name.visibility = if (showName) View.VISIBLE else View.GONE
        if (name != null) h.name.text = name
        // 选中态：网格卡片描边高亮
        h.thumb.background = GradientDrawable().apply {
            setColor(0xFFF5F5F7.toInt())
            cornerRadius = dp(8).toFloat()
            if (selected) {
                setStroke(dp(3), Color.parseColor("#1E88E5"))
            }
        }
        h.diffTag.visibility = if (difficulty != null) View.VISIBLE else View.GONE
        if (difficulty != null) {
            h.diffTag.text = when (difficulty) {
                1 -> "入门"
                2 -> "简单"
                else -> "进阶"
            }
            h.diffTag.setTextColor(
                when (difficulty) {
                    1 -> Color.parseColor("#43A047")
                    2 -> Color.parseColor("#FB8C00")
                    else -> Color.parseColor("#E53935")
                }
            )
            h.diffTag.background = GradientDrawable().apply {
                cornerRadius = 999f
                setColor(
                    when (difficulty) {
                        1 -> 0x2643A047.toInt()
                        2 -> 0x26FB8C00.toInt()
                        else -> 0x26E53935.toInt()
                    }
                )
            }
        }
        if (showThumb && thumbItem != null) {
            onThumbBind(h.thumb, thumbItem, currentCategoryForGrid?.id ?: "")
        } else {
            h.thumb.setImageDrawable(null)
        }
    }

    private fun dp(v: Int): Int = (v * density).toInt()

    class Holder(
        itemView: View,
        val emoji: TextView,
        val title: TextView,
        val subtitle: TextView,
        val thumb: ImageView,
        val name: TextView,
        val diffTag: TextView,
    ) : RecyclerView.ViewHolder(itemView)
}
