package cc.ispot.netab.androiddeployer

import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Simple OTA updater shell used to install and update the fast-moving Android
 * tester APK from the VPS-hosted manifest feed.
 */
class MainActivity : AppCompatActivity() {
    private companion object {
        const val PREFS_NAME = "android_deployer"
        const val PREF_LAST_MANIFEST_URL = "lastManifestUrl"
    }

    private lateinit var manifestUrlInput: EditText
    private lateinit var statusOutput: TextView
    private lateinit var feedOutput: TextView
    private lateinit var installedOutput: TextView
    private lateinit var availableOutput: TextView
    private lateinit var releaseOutput: TextView
    private lateinit var updateButton: Button
    private lateinit var prefs: SharedPreferences
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private var currentManifest: ReleaseManifest? = null
    private var isLoading: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        manifestUrlInput = findViewById(R.id.manifest_url_input)
        statusOutput = findViewById(R.id.status_output)
        feedOutput = findViewById(R.id.feed_output)
        installedOutput = findViewById(R.id.installed_output)
        availableOutput = findViewById(R.id.available_output)
        releaseOutput = findViewById(R.id.release_output)
        updateButton = findViewById(R.id.button_update)

        val lastUrl = prefs.getString(PREF_LAST_MANIFEST_URL, null)
        manifestUrlInput.setText(lastUrl ?: getString(R.string.default_app_tester_manifest))

        findViewById<Button>(R.id.button_reload_manifest).setOnClickListener {
            loadManifest(manifestUrlInput.text.toString().trim(), saveAsDefault = false)
        }

        findViewById<Button>(R.id.button_use_manifest).setOnClickListener {
            loadManifest(manifestUrlInput.text.toString().trim(), saveAsDefault = true)
        }

        updateButton.setOnClickListener {
            val manifest = currentManifest ?: return@setOnClickListener
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(manifest.apkUrl)))
        }

        refreshFromCurrentInput()
    }

    override fun onResume() {
        super.onResume()
        if (!isLoading) {
            refreshFromCurrentInput()
        }
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    /**
     * Handles refresh from current input.
     */
    private fun refreshFromCurrentInput() {
        loadManifest(manifestUrlInput.text.toString().trim(), saveAsDefault = false)
    }

    /**
     * Handles load manifest.
     * @param url Url.
     * @param saveAsDefault Save as default.
     */
    private fun loadManifest(url: String, saveAsDefault: Boolean) {
        if (url.isBlank()) {
            statusOutput.text = "Status: manifest URL is empty"
            feedOutput.text = getString(R.string.no_release_loaded)
            availableOutput.text = getString(R.string.not_available)
            installedOutput.text = getString(R.string.not_installed)
            updateButton.isEnabled = false
            updateButton.text = getString(R.string.button_update)
            return
        }

        if (saveAsDefault) {
            prefs.edit().putString(PREF_LAST_MANIFEST_URL, url).apply()
        }

        currentManifest = null
        isLoading = true
        updateButton.isEnabled = false
        updateButton.text = getString(R.string.button_checking)
        statusOutput.text = "Status: checking $url"
        feedOutput.text = getString(R.string.no_release_loaded)
        availableOutput.text = getString(R.string.not_available)
        installedOutput.text = getString(R.string.not_installed)
        releaseOutput.text = ""

        executor.execute {
            try {
                val manifest = UpdateRepository.fetch(url)
                val installedState = loadInstalledPackageState(manifest.packageName)
                runOnUiThread {
                    isLoading = false
                    currentManifest = manifest
                    prefs.edit().putString(PREF_LAST_MANIFEST_URL, url).apply()
                    updateVersionUi(manifest, installedState)
                    releaseOutput.text = buildString {
                        appendLine("Manifest: $url")
                        appendLine("Commit: ${manifest.gitCommit}")
                        appendLine("Built: ${manifest.builtAt}")
                        appendLine("APK URL: ${manifest.apkUrl}")
                        appendLine("SHA256: ${manifest.sha256}")
                        appendLine("Size: ${manifest.sizeBytes} bytes")
                        if (manifest.releaseNotes.isNotEmpty()) {
                            appendLine("Notes:")
                            manifest.releaseNotes.forEach { note -> appendLine("- $note") }
                        }
                    }.trim()
                }
            } catch (error: Throwable) {
                runOnUiThread {
                    isLoading = false
                    currentManifest = null
                    updateButton.isEnabled = false
                    updateButton.text = getString(R.string.button_update)
                    statusOutput.text = "Status: error"
                    feedOutput.text = getString(R.string.no_release_loaded)
                    availableOutput.text = getString(R.string.not_available)
                    installedOutput.text = getString(R.string.not_installed)
                    releaseOutput.text = error.message ?: error.toString()
                }
            }
        }
    }

    /**
     * Handles update version UI.
     * @param manifest Snapshot manifest.
     * @param installedState Installed state.
     */
    private fun updateVersionUi(manifest: ReleaseManifest, installedState: InstalledPackageState?) {
        val installedLabel =
            if (installedState == null) {
                getString(R.string.not_installed)
            } else {
                "${installedState.versionName} (${installedState.versionCode})"
            }
        val availableLabel = "${manifest.versionName} (${manifest.versionCode})"
        val needsInstall = installedState == null
        val needsUpdate =
            installedState != null && manifest.versionCode > installedState.versionCode

        feedOutput.text = buildString {
            appendLine("${getString(R.string.label_name)}: ${manifest.appId}")
            appendLine("${getString(R.string.label_channel)}: ${manifest.channel}")
            append("${getString(R.string.label_package)}: ${manifest.packageName}")
        }
        installedOutput.text = "${getString(R.string.label_installed)}: $installedLabel"
        availableOutput.text = "${getString(R.string.label_available)}: $availableLabel"

        when {
            needsInstall -> {
                statusOutput.text = "Status: app is not installed on this device"
                updateButton.isEnabled = true
                updateButton.text = getString(R.string.button_install)
            }
            needsUpdate -> {
                statusOutput.text = "Status: newer version is available"
                updateButton.isEnabled = true
                updateButton.text = getString(R.string.button_update)
            }
            else -> {
                statusOutput.text = "Status: installed version is current"
                updateButton.isEnabled = false
                updateButton.text = getString(R.string.button_up_to_date)
            }
        }
    }

    /**
     * Handles load installed package state.
     * @param packageName Package name.
     */
    private fun loadInstalledPackageState(packageName: String): InstalledPackageState? = try {
        @Suppress("DEPRECATION")
        val packageInfo =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                packageManager.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                packageManager.getPackageInfo(packageName, 0)
            }
        InstalledPackageState(
            versionCode = packageInfo.longVersionCode.toInt(),
            versionName = packageInfo.versionName ?: getString(R.string.not_available)
        )
    } catch (_: Throwable) {
        null
    }
}

/** Installed package metadata for the APK currently present on the device. */
private data class InstalledPackageState(val versionCode: Int, val versionName: String)
