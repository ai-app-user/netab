package cc.ispot.netab.apptester

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * Small Android HTTP client for talking to a reachable coord node.
 *
 * It keeps all RPC framing logic in one place so the activity can focus on the
 * guided playground UX.
 */
class CoordRpcClient {
    /** Fetch `/healthz` from the configured sender and return HTTP status plus raw body. */
    fun health(senderUrl: String, timeoutMs: Int): Pair<Int, String> {
        val url = "${normalizeSenderBaseUrl(senderUrl)}/healthz"
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = timeoutMs
        connection.readTimeout = timeoutMs

        try {
            val status = connection.responseCode
            val body = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()
                ?.use { it.readText() }
                ?.trim()
                .orEmpty()
            return status to body
        } finally {
            connection.disconnect()
        }
    }

    /** Call one raw RPC method directly on the selected sender node. */
    fun call(
        senderUrl: String,
        method: String,
        params: Any = JSONObject(),
        timeoutMs: Int
    ): JSONObject {
        val request = JSONObject()
            .put("method", method)
            .put("params", params)
            .put(
                "auth",
                JSONObject()
                    .put("userId", "android:app_tester")
                    .put("groups", JSONArray().put("grp:internal"))
                    .put("internal", true)
            )
            .put("traceId", "android-app-tester-${System.currentTimeMillis()}")

        val response =
            postJson("${normalizeSenderBaseUrl(senderUrl)}/rpc", request.toString(), timeoutMs)
        if (!response.optBoolean("ok", false)) {
            val message = response.optJSONObject("error")?.optString("message")?.ifBlank { null }
                ?: "RPC $method failed"
            throw IllegalStateException(message)
        }
        return response
    }

    /** Execute one method either locally on the sender or remotely via `cord.foundation.exec`. */
    fun execute(
        senderUrl: String,
        remoteMethod: String,
        remoteParams: Any,
        targetText: String?,
        timeoutMs: Int
    ): JSONObject {
        val dst = parseExecTarget(targetText)
        if (dst == null) {
            return call(senderUrl, remoteMethod, remoteParams, timeoutMs)
        }
        val execParams = JSONObject()
            .put("method", remoteMethod)
            .put("params", remoteParams)
            .put("dst", dst)
            .put("timeoutMs", timeoutMs)
        return call(senderUrl, "cord.foundation.exec", execParams, timeoutMs)
    }

    /** POST one JSON payload and normalize the JSON response shape. */
    private fun postJson(url: String, body: String, timeoutMs: Int): JSONObject {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = timeoutMs
        connection.readTimeout = timeoutMs
        connection.doOutput = true
        connection.setRequestProperty("content-type", "application/json")

        try {
            connection.outputStream.bufferedWriter().use { it.write(body) }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()
                ?.use { it.readText() }
                ?.trim()
                .orEmpty()
            val parsed = if (text.isBlank()) JSONObject() else JSONTokener(text).nextValue()
            val response = when (parsed) {
                is JSONObject -> parsed
                is JSONArray -> JSONObject().put("ok", status in 200..299).put("result", parsed)
                else -> JSONObject().put("ok", status in 200..299).put("result", parsed)
            }
            if (status !in 200..299) {
                val message =
                    response.optJSONObject("error")?.optString("message")?.ifBlank { null }
                        ?: "HTTP $status ${URL(url).path}"
                throw IllegalStateException(message)
            }
            return response
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        /** Normalize a user-entered sender URL into `scheme://host:port` form. */
        fun normalizeSenderBaseUrl(raw: String): String {
            val text = raw.trim()
            require(text.isNotBlank()) { "Sender URL is empty" }

            val withScheme = if (text.startsWith("http://") || text.startsWith("https://")) {
                text
            } else {
                "http://$text"
            }

            val parsed = URL(withScheme)
            val portSuffix = if (parsed.port > 0) ":${parsed.port}" else ""
            return "${parsed.protocol}://${parsed.host}$portSuffix"
        }

        /** Normalize a node selector or URL typed into the target field. */
        fun normalizeTargetText(raw: String?): String = raw
            ?.trim()
            ?.removePrefix("@")
            ?.removePrefix("%")
            ?.takeIf { it.isNotBlank() }
            ?.let { value ->
                if (value.startsWith("http://") || value.startsWith("https://")) {
                    val url = URL(value)
                    val portSuffix = if (url.port > 0) ":${url.port}" else ""
                    "${url.host}$portSuffix"
                } else {
                    value
                        .removeSuffix("/healthz")
                        .removeSuffix("/rpc")
                        .trimEnd('/')
                }
            }
            .orEmpty()

        /** Convert target text into the JSON selector object expected by `cord.foundation.exec`. */
        fun parseExecTarget(raw: String?): JSONObject? {
            val normalized = normalizeTargetText(raw)
            if (normalized.isBlank()) {
                return null
            }
            return if (looksLikeAddr(normalized)) {
                JSONObject().put("kind", "addr").put("value", normalized)
            } else {
                JSONObject().put("kind", "node").put("value", normalized)
            }
        }

        /** Best-effort check for whether a normalized target looks like `host:port`. */
        fun looksLikeAddr(raw: String?): Boolean {
            val normalized = normalizeTargetText(raw)
            return normalized.contains(":")
        }

        /** Render a routed exec result into the same arrow notation used by the CLI. */
        fun renderRoute(route: JSONObject): String {
            val hops = route.optJSONArray("hops")
            if (hops == null || hops.length() == 0) {
                return route.optJSONArray("path")?.let { pathArray ->
                    buildString {
                        for (index in 0 until pathArray.length()) {
                            if (index > 0) {
                                append(" -> ")
                            }
                            append(pathArray.optString(index))
                        }
                    }
                }?.ifBlank {
                    route.optString("executedNodeId", route.optString("contactedNodeId", "local"))
                }
                    ?: route.optString(
                        "executedNodeId",
                        route.optString("contactedNodeId", "local")
                    )
            }

            val first = hops.optJSONObject(0)
            val builder = StringBuilder(first?.optString("from").orEmpty())
            for (index in 0 until hops.length()) {
                val hop = hops.optJSONObject(index) ?: continue
                val arrow = if (hop.optString("kind") == "reverse") " -< " else " -> "
                builder.append(arrow).append(hop.optString("to"))
            }
            return builder.toString()
        }
    }
}
