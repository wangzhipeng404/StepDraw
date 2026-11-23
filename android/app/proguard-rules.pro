# StepDraw Android — ProGuard 规则
# release 构建 isMinifyEnabled=false，默认不做混淆。
# 如未来开启混淆，Gson 反序列化需要保留数据模型字段名。

# 保留 Gson 解析的数据模型（字段名即 JSON key）
-keep class com.stepdraw.android.data.** { *; }

# OkHttp / Okio
-dontwarn okhttp3.**
-dontwarn okio.**
