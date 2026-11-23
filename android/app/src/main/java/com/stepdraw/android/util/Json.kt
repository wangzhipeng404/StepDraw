package com.stepdraw.android.util

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.reflect.TypeToken

/** Gson 封装（字段名与 JSON 一一对应，无需映射） */
object Json {
    private val gson: Gson = GsonBuilder().create()

    fun <T> parse(clazz: Class<T>, data: ByteArray): T =
        gson.fromJson(String(data, Charsets.UTF_8), clazz)

    fun <T> parse(type: TypeToken<T>, data: ByteArray): T =
        gson.fromJson(String(data, Charsets.UTF_8), type)
}
