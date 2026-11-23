package com.stepdraw.android

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.fragment.app.DialogFragment
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
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
 * 图案选择底部弹窗：分组 → 分类 → 图案网格（搜索/难度筛选/分页加载）。
 * 与 ipad/PatternBrowser.swift 同构，用单 RecyclerView + 页面栈模拟 NavigationStack。
 * 选中图案后通过 [PatternListener] 回调宿主。
 */
class PatternBrowserBottomSheet : DialogFragment() {

    private val pages = ArrayDeque<Page>()
    private lateinit var adapter: PatternAdapter
    private var gridItems: MutableList<DrawingItem> = mutableListOf()
    private var gridLoaded = 0
    private var gridLoading = false
    private var currentGridCategory: String? = null
    private var mainIndex: MainIndex? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    // 头部控件
    private lateinit var root: LinearLayout
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
        fun newInstance(): PatternBrowserBottomSheet = PatternBrowserBottomSheet()
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        val ctx = requireContext()

        root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(16).toFloat()
            }
        }

        // ===== 头部 =====
        val header = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        btnBack = ImageButton(ctx).apply {
            setImageResource(android.R.drawable.ic_menu_revert)
            setColorFilter(Color.parseColor("#8E8E93"))
            val p = dp(4)
            setPadding(p, p, p, p)
            background = null
            visibility = View.GONE
            setOnClickListener { popPage() }
        }
        tvTitle = TextView(ctx).apply {
            text = "选择图案"
            textSize = 16f
            setTextColor(Color.parseColor("#1C1C1E"))
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 1
        }
        searchBox = EditText(ctx).apply {
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
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).also {
                it.marginStart = dp(8)
            },
        )
        header.addView(
            searchBox,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.4f).also {
                it.marginStart = dp(8)
            },
        )
        root.addView(header)

        // ===== 难度筛选（网格页显示）=====
        diffChips = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
        }
        val diffLabels = arrayOf("全部", "入门", "简单", "进阶")
        diffButtons = Array(4) { i ->
            TextView(ctx).apply {
                text = diffLabels[i]
                textSize = 12f
                setPadding(dp(10), dp(5), dp(10), dp(5))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).also { it.marginStart = if (i == 0) 0 else dp(6) }
                setOnClickListener { applyDifficulty(i) }
            }
        }
        for (b in diffButtons) diffChips.addView(b)
        root.addView(
            diffChips,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).also { it.topMargin = dp(10) },
        )

        // ===== 列表区 =====
        rv = RecyclerView(ctx).apply {
            layoutManager = GridLayoutManager(ctx, 3)
            isVerticalScrollBarEnabled = true
        }
        root.addView(
            rv,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f,
            ).also { it.topMargin = dp(10) },
        )

        progressView = ProgressBar(ctx).apply { visibility = View.VISIBLE }
        root.addView(
            progressView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).also {
                it.topMargin = dp(10)
                it.gravity = Gravity.CENTER
            },
        )

        adapter = PatternAdapter(
            density = resources.displayMetrics.density,
            onGroupClick = { pushCategory(it) },
            onCategoryClick = { pushGrid(it) },
            onItemSelect = { item ->
                val cat = currentGridCategory ?: return@PatternAdapter
                val host = activity as? PatternListener
                host?.onPatternSelected(cat, item)
                dismiss()
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

        return root
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
        pages.addLast(Page.CategoryList(group, cats))
        renderCurrentPage()
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
        } else {
            dismiss()
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
        val g = pages.last() as? Page.Grid ?: return
        if (gridLoaded >= gridItems.size) return
        gridLoaded = (gridLoaded + PAGE).coerceAtMost(gridItems.size)
        // loadMore 在 onBindViewHolder 期间被触发，notify 必须 post 出去，否则会抛
        // IllegalStateException（Cannot call this method while RecyclerView is computing a layout）
        rv.post {
            if (!isAdded) return@post
            val fresh = pages.last() as? Page.Grid ?: return@post
            val newPage = fresh.copy(loadedCount = gridLoaded)
            pages.removeLast()
            pages.addLast(newPage)
            adapter.submit(newPage)
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
                rv.layoutManager = GridLayoutManager(requireContext(), 3)
                adapter.submit(page)
            }

            is Page.CategoryList -> {
                tvTitle.text = page.group.name
                btnBack.visibility = View.VISIBLE
                searchBox.visibility = View.GONE
                diffChips.visibility = View.GONE
                rv.layoutManager = GridLayoutManager(requireContext(), 3)
                adapter.submit(page)
            }

            is Page.Grid -> {
                tvTitle.text = page.category.displayName
                btnBack.visibility = View.VISIBLE
                searchBox.visibility = View.VISIBLE
                diffChips.visibility = View.VISIBLE
                refreshDiffChips(page.difficulty)
                val span = if (rv.width > 0) {
                    (rv.width / dp(108)).coerceIn(2, 8)
                } else 4
                rv.layoutManager = GridLayoutManager(requireContext(), span)
                adapter.submit(page)
                searchBox.setText(page.query)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        dialog?.window?.let { w ->
            val wm = requireContext().getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
            val dm = android.util.DisplayMetrics()
            wm.defaultDisplay.getMetrics(dm)
            w.setLayout(
                (dm.widthPixels * 0.85f).toInt(),
                (dm.heightPixels * 0.82f).toInt(),
            )
        }
    }

    override fun onDestroyView() {
        scope.cancel()
        super.onDestroyView()
    }

    private fun dp(v: Int): Int =
        (v * resources.displayMetrics.density).toInt()

    private fun hideKeyboard() {
        val imm = requireContext().getSystemService(Context.INPUT_METHOD_SERVICE)
            as? android.view.inputmethod.InputMethodManager
        imm?.hideSoftInputFromWindow(searchBox.windowToken, 0)
    }
}

/**
 * 三态适配器：分组卡片 / 分类卡片 / 图案网格卡片。统一用一个 ViewHolder 承载所有子视图。
 */
private class PatternAdapter(
    private val density: Float,
    private val onGroupClick: (MainGroup) -> Unit,
    private val onCategoryClick: (MainCategory) -> Unit,
    private val onItemSelect: (DrawingItem) -> Unit,
    private val onThumbBind: (ImageView, DrawingItem, String) -> Unit,
    private val onReachEnd: () -> Unit,
) : RecyclerView.Adapter<PatternAdapter.Holder>() {

    private var page: Any? = null
    private var currentCategoryForGrid: MainCategory? = null

    fun submit(page: Any) {
        this.page = page
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
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).also { it.setMargins(dp(6), dp(6), dp(6), dp(6)) }
        }
        val emoji = TextView(ctx).apply {
            textSize = 34f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
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
            layoutParams = LinearLayout.LayoutParams(dp(84), dp(84))
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
