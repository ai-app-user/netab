package cc.ispot.netab.androiddeployer

import java.net.HttpURLConnection
import java.net.URL

/** Network helper that downloads the latest Android release manifest. */
object UpdateRepository {
    /** Download, validate, and parse one release manifest URL. */
    fun fetch(url: String): ReleaseManifest {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.setRequestProperty("Accept", "application/json")

        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (status !in 200..299) {
                error("Manifest fetch failed with HTTP $status\n$body")
            }
            return ReleaseManifest.fromJson(body, url)
        } finally {
            connection.disconnect()
        }
    }
}
