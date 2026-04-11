package cc.ispot.netab.androiddeployer

import java.net.URL
import org.json.JSONObject

/** Parsed release metadata downloaded by the Android deployer shell. */
data class ReleaseManifest(
    val appId: String,
    val channel: String,
    val packageName: String,
    val versionCode: Int,
    val versionName: String,
    val gitCommit: String,
    val builtAt: String,
    val apkUrl: String,
    val sha256: String,
    val sizeBytes: Long,
    val releaseNotes: List<String>
) {
    companion object {
        /** Parse one manifest JSON document and resolve its APK URL relative to the manifest URL. */
        fun fromJson(raw: String, manifestUrl: String): ReleaseManifest {
            val json = JSONObject(raw)
            val notes = mutableListOf<String>()
            val releaseNotes = json.optJSONArray("releaseNotes")
            if (releaseNotes != null) {
                for (i in 0 until releaseNotes.length()) {
                    notes.add(releaseNotes.optString(i))
                }
            }

            val resolvedApkUrl = URL(URL(manifestUrl), json.getString("apkUrl")).toString()

            return ReleaseManifest(
                appId = json.getString("appId"),
                channel = json.getString("channel"),
                packageName = json.getString("packageName"),
                versionCode = json.getInt("versionCode"),
                versionName = json.getString("versionName"),
                gitCommit = json.optString("gitCommit"),
                builtAt = json.optString("builtAt"),
                apkUrl = resolvedApkUrl,
                sha256 = json.optString("sha256"),
                sizeBytes = json.optLong("sizeBytes"),
                releaseNotes = notes
            )
        }
    }
}
