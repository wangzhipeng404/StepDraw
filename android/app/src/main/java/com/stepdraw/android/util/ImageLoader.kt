package com.stepdraw.android.util

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import android.widget.ImageView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * 轻量图片加载器（LruCache 内存缓存 + OkHttp 下载 + 后台解码）。
 * 缩略图尺寸统一裁剪到 256px，足够列表网格用。
 */
object ImageLoader {

    private const val MAX_SIZE = 256

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    // 上限按 maxMemory 的 1/8（sizeOf 返回字节数），并夹在合理区间防 32 位溢出
    private val cacheMaxBytes = (Runtime.getRuntime().maxMemory().toInt() / 8).coerceIn(8 * 1024 * 1024, 64 * 1024 * 1024)

    private val memoryCache = object : LruCache<String, Bitmap>(cacheMaxBytes) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    @Volatile
    private var scope: CoroutineScope? = null

    fun ensureScope(newScope: CoroutineScope) {
        scope?.cancel()
        scope = newScope
    }

    private fun decode(url: String): Bitmap? {
        client.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val bytes = resp.body?.bytes() ?: return null
            if (bytes.isEmpty()) return null
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            var sample = 1
            val target = MAX_SIZE
            while (opts.outWidth / sample > target * 2 || opts.outHeight / sample > target * 2) {
                sample *= 2
            }
            val realOpts = BitmapFactory.Options().apply { inSampleSize = sample }
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, realOpts)
        }
    }

    /** 异步加载 url 到 imageView（带缓存 + 防重复请求） */
    fun load(imageView: ImageView, url: String?) {
        imageView.tag = url
        if (url == null) {
            imageView.setImageBitmap(null)
            return
        }
        memoryCache.get(url)?.let {
            imageView.setImageBitmap(it)
            return
        }
        val s = scope ?: return
        s.launch(Dispatchers.IO) {
            val bmp = decode(url) ?: return@launch
            memoryCache.put(url, bmp)
            s.launch(Dispatchers.Main) {
                if (imageView.tag == url) {
                    imageView.setImageBitmap(bmp)
                }
            }
        }
    }
}
