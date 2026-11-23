package com.stepdraw.android.data

import android.content.Context
import android.util.LruCache
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * 数据加载 + 缓存 —— 与 ipad/DataStore.swift 同构。
 * 远程数据来自 GitHub Pages（与 web 端同源），磁盘缓存在 cacheDir/StepDrawData。
 * 缓存 key 与 URL path 一致；index.json 强制刷新，保证拿到最新索引。
 */
class DataStore private constructor(context: Context) {

    /** 远程数据根地址。打包发布后如需换 CDN，只改这里。 */
    companion object {
        @Volatile
        private var _instance: DataStore? = null

        const val REMOTE_BASE_URL = "https://wangzhipeng404.github.io/StepDraw/data"

        fun getInstance(): DataStore {
            _instance?.let { return it }
            throw IllegalStateException("DataStore.attach() 未调用（见 StepDrawApp）")
        }

        @JvmStatic
        fun attach(context: Context) {
            if (_instance == null) {
                _instance = DataStore(context.applicationContext)
            }
        }
    }

    private val cacheDir: File
    private val client: OkHttpClient
    private val memoryCache = object : LruCache<String, ByteArray>(16 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray): Int = value.size
    }
    private val inFlight = ConcurrentHashMap<String, CompletableDeferred<ByteArray>>()

    init {
        this.cacheDir = File(context.cacheDir, "StepDrawData")
        if (!cacheDir.exists()) cacheDir.mkdirs()
        this.client = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }

    // MARK: - 主索引

    suspend fun loadMainIndex(force: Boolean = false): MainIndex {
        val data = fetch("index.json", force = force)
        return withContext(Dispatchers.IO) {
            com.stepdraw.android.util.Json.parse(MainIndex::class.java, data)
        }
    }

    // MARK: - 分类索引

    suspend fun loadCategoryIndex(categoryId: String): CategoryIndex {
        val data = fetch("$categoryId/index.json")
        return withContext(Dispatchers.IO) {
            com.stepdraw.android.util.Json.parse(CategoryIndex::class.java, data)
        }
    }

    // MARK: - 单个图案

    suspend fun loadDrawing(categoryId: String, drawingId: String): Drawing {
        val data = fetch("$categoryId/$drawingId.json")
        return withContext(Dispatchers.IO) {
            com.stepdraw.android.util.Json.parse(Drawing::class.java, data)
        }
    }

    /** 缩略图 URL（直接走远程，由 ImageView 异步加载层缓存） */
    fun thumbnailURL(categoryId: String, item: DrawingItem): String {
        val thumb = item.thumbnail
        if (!thumb.isNullOrEmpty()) {
            val cleaned = thumb.trimStart('/')
            return "$REMOTE_BASE_URL/$cleaned"
        }
        return "$REMOTE_BASE_URL/$categoryId/${item.id}.png"
    }

    // MARK: - 下载（内存/磁盘缓存 + 去重）

    /** 拉取并缓存一个资源。`force` 时跳过内存/磁盘缓存强制走网络。 */
    private suspend fun fetch(path: String, force: Boolean = false): ByteArray {
        // 内存缓存
        if (!force) {
            memoryCache.get(path)?.let { return it }
        }
        // 进行中的同 key 请求去重：后到者 await 先到者的结果
        val myDeferred = CompletableDeferred<ByteArray>()
        val existing = inFlight.putIfAbsent(path, myDeferred)
        if (existing != null) {
            return existing.await()   // 已完成则立即返回；失败则抛出其异常
        }
        try {
            val data = performFetch(path, force)
            myDeferred.complete(data)
            memoryCache.put(path, data)
            return data
        } catch (t: Throwable) {
            myDeferred.completeExceptionally(t)
            throw t
        } finally {
            inFlight.remove(path, myDeferred)
        }
    }

    private suspend fun performFetch(path: String, force: Boolean): ByteArray =
        withContext(Dispatchers.IO) {
            // 磁盘缓存
            val file = File(cacheDir, path)
            if (!force && file.exists() && file.length() > 0) {
                return@withContext file.readBytes()
            }

            val requestBuilder = Request.Builder().url("$REMOTE_BASE_URL/$path")
            // index 文件强制刷新（内容会随素材库更新）
            if (path.endsWith("index.json")) {
                requestBuilder.header("Cache-Control", "no-cache")
            }
            client.newCall(requestBuilder.build()).execute().use { resp ->
                if (!resp.isSuccessful) {
                    throw java.io.IOException("HTTP ${resp.code}")
                }
                val bytes = resp.body?.bytes() ?: throw java.io.IOException("empty body")
                if (bytes.isEmpty()) throw java.io.IOException("empty response")
                // 写入磁盘缓存（路径含 "/"，逐级建目录）
                try {
                    file.parentFile?.mkdirs()
                    file.writeBytes(bytes)
                } catch (_: Exception) { /* 缓存写失败不致命 */ }
                bytes
            }
        }

    // MARK: - 缓存管理

    fun cacheSizeBytes(): Long {
        return cacheDir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
    }

    fun clearCache() {
        cacheDir.deleteRecursively()
        cacheDir.mkdirs()
        memoryCache.evictAll()
    }
}
