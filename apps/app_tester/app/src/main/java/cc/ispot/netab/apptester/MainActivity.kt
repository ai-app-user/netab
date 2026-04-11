package cc.ispot.netab.apptester

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.SharedPreferences
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * Guided Android playground for exercising the embedded `coord` and `steng`
 * runtimes without a desktop shell.
 *
 * The activity mirrors the Linux playground in a phone-friendly flow:
 * select a subsystem, select a command, fill only the relevant parameters,
 * then inspect the output and recent command history.
 */
class MainActivity : AppCompatActivity() {
    /** High-level subsystem currently under test. */
    private enum class TestedApp(val id: String, val label: String) {
        COORD("coord", "coord"),
        STENG("steng", "steng");

        companion object {
            /**
             * Handles from id.
             * @param value Value to process.
             */
            fun fromId(value: String?): TestedApp = values().firstOrNull { it.id == value } ?: COORD
        }
    }

    /** One input field shown for the currently selected command. */
    private data class ParamSpec(
        val key: String,
        val label: String,
        val hint: String,
        val help: String,
        val prefKey: String = key,
        val defaultValue: String = "",
        val multiline: Boolean = false,
        val inputType: Int = InputType.TYPE_CLASS_TEXT,
        val optional: Boolean = false
    )

    /** One guided playground action exposed by the UI. */
    private data class CommandSpec(
        val app: TestedApp,
        val id: String,
        val label: String,
        val description: String,
        val params: List<ParamSpec>
    )

    /** Normalized result shown in the output panel after one action runs. */
    private data class CommandResult(
        val status: String,
        val output: String,
        val newSenderUrl: String? = null
    )

    private lateinit var prefs: SharedPreferences
    private lateinit var databaseHelper: TesterDatabaseHelper
    private lateinit var embeddedCoordNode: EmbeddedCoordNode
    private lateinit var appSpinner: Spinner
    private lateinit var commandSpinner: Spinner
    private lateinit var commandDescriptionOutput: TextView
    private lateinit var commandHelpButton: Button
    private lateinit var paramContainer: LinearLayout
    private lateinit var runCommandButton: Button
    private lateinit var statusOutput: TextView
    private lateinit var contextOutput: TextView
    private lateinit var latestOutput: TextView
    private lateinit var historyOutput: TextView

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val rpcClient = CoordRpcClient()
    private val visibleParamInputs = linkedMapOf<String, EditText>()
    private var suppressSpinnerCallbacks = false
    private var currentApp: TestedApp = TestedApp.COORD
    private var currentCommand: CommandSpec? = null

    /** Full command catalog rendered through the guided selectors. */
    private val commandSpecs: List<CommandSpec> by lazy { buildCommandSpecs() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences("app_tester", Context.MODE_PRIVATE)
        databaseHelper = TesterDatabaseHelper(this)
        embeddedCoordNode = EmbeddedCoordNode.get(databaseHelper)

        appSpinner = findViewById(R.id.app_spinner)
        commandSpinner = findViewById(R.id.command_spinner)
        commandDescriptionOutput = findViewById(R.id.command_description_output)
        commandHelpButton = findViewById(R.id.command_help_button)
        paramContainer = findViewById(R.id.param_container)
        runCommandButton = findViewById(R.id.run_command_button)
        statusOutput = findViewById(R.id.status_output)
        contextOutput = findViewById(R.id.context_output)
        latestOutput = findViewById(R.id.latest_output)
        historyOutput = findViewById(R.id.history_output)

        bindSpinners()
        runCommandButton.setOnClickListener { guarded { runSelectedCommand() } }
        renderStatus("Ready")

        executor.execute {
            try {
                val restored = embeddedCoordNode.autoRestore()
                if (restored != null) {
                    runOnUiThread {
                        renderStatus("Local node restored")
                        appendHistory(
                            buildString {
                                appendLine("Auto-restored local embedded coord")
                                append(prettyValue(restored))
                            }.trim()
                        )
                        refreshVisibleSenderUrl()
                    }
                }
            } catch (error: Throwable) {
                runOnUiThread {
                    renderStatus("Auto-restore failed")
                    appendHistory("Auto-restore failed\n${error.message ?: error}")
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        renderStatus(statusOutput.text.toString().removePrefix("Status: ").ifBlank { "Ready" })
    }

    override fun onPause() {
        persistVisibleInputs()
        super.onPause()
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    /**
     * Handles bind spinners.
     */
    private fun bindSpinners() {
        val appLabels = TestedApp.values().map { it.label }
        appSpinner.adapter =
            ArrayAdapter(this, android.R.layout.simple_spinner_item, appLabels).also {
                it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
            }
        appSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(
                parent: AdapterView<*>?,
                view: android.view.View?,
                position: Int,
                id: Long
            ) {
                if (suppressSpinnerCallbacks) {
                    return
                }
                currentApp = TestedApp.values()[position]
                prefs.edit().putString("selectedApp", currentApp.id).apply()
                refreshCommandSpinner()
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }

        commandSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(
                parent: AdapterView<*>?,
                view: android.view.View?,
                position: Int,
                id: Long
            ) {
                if (suppressSpinnerCallbacks) {
                    return
                }
                val commands = visibleCommands()
                currentCommand = commands.getOrNull(position)
                currentCommand?.let {
                    prefs.edit().putString(selectedCommandPrefKey(currentApp), it.id).apply()
                }
                renderCommandForm()
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }

        suppressSpinnerCallbacks = true
        currentApp = TestedApp.fromId(prefs.getString("selectedApp", TestedApp.COORD.id))
        appSpinner.setSelection(TestedApp.values().indexOf(currentApp).coerceAtLeast(0))
        suppressSpinnerCallbacks = false
        refreshCommandSpinner()
    }

    /**
     * Handles refresh command spinner.
     */
    private fun refreshCommandSpinner() {
        val commands = visibleCommands()
        val labels = commands.map { it.label }
        suppressSpinnerCallbacks = true
        commandSpinner.adapter =
            ArrayAdapter(this, android.R.layout.simple_spinner_item, labels).also {
                it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
            }
        val selectedId = prefs.getString(
            selectedCommandPrefKey(currentApp),
            commands.firstOrNull()?.id
        )
        val index = commands.indexOfFirst { it.id == selectedId }.let { if (it < 0) 0 else it }
        commandSpinner.setSelection(index)
        currentCommand = commands.getOrNull(index)
        suppressSpinnerCallbacks = false
        renderCommandForm()
    }

    /**
     * Handles visible commands.
     */
    private fun visibleCommands(): List<CommandSpec> = commandSpecs.filter { it.app == currentApp }

    /**
     * Handles render command form.
     */
    private fun renderCommandForm() {
        val command = currentCommand ?: return
        commandDescriptionOutput.text = command.description
        commandHelpButton.setOnClickListener { showHelp(command.label, command.description) }
        runCommandButton.text = "Run ${command.label}"

        visibleParamInputs.clear()
        paramContainer.removeAllViews()

        if (command.params.isEmpty()) {
            val noParams = TextView(this).apply {
                text = getString(R.string.no_params_required)
            }
            paramContainer.addView(noParams)
        } else {
            command.params.forEach { spec ->
                paramContainer.addView(createParamView(spec))
            }
        }
        renderStatus(statusOutput.text.toString().removePrefix("Status: ").ifBlank { "Ready" })
    }

    /**
     * Creates param view.
     * @param spec Spec.
     */
    private fun createParamView(spec: ParamSpec): LinearLayout {
        val wrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(10)
            }
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val labelView = TextView(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            text = if (spec.optional) "${spec.label} (optional)" else spec.label
            textSize = 15f
        }
        val helpButton = Button(this).apply {
            text = getString(R.string.help_short)
            setOnClickListener { showHelp(spec.label, spec.help) }
        }
        header.addView(labelView)
        header.addView(helpButton)

        val input = EditText(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(6)
            }
            hint = spec.hint
            inputType =
                if (spec.multiline) {
                    InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
                } else {
                    spec.inputType
                }
            setText(defaultValueFor(spec))
            if (spec.multiline) {
                minLines = 4
                gravity = Gravity.TOP or Gravity.START
            }
        }

        visibleParamInputs[spec.key] = input
        wrapper.addView(header)
        wrapper.addView(input)
        return wrapper
    }

    /**
     * Returns the default value for.
     * @param spec Spec.
     */
    private fun defaultValueFor(spec: ParamSpec): String = when (spec.key) {
        "senderUrl" -> embeddedCoordNode.currentSenderUrl()
            ?: prefs.getString(spec.prefKey, spec.defaultValue).orEmpty()
        else -> prefs.getString(spec.prefKey, spec.defaultValue).orEmpty()
    }

    /**
     * Runs selected command.
     */
    private fun runSelectedCommand() {
        val command = currentCommand ?: return
        val values = collectVisibleValues()
        persistValues(values)
        runBackgroundAction(command.label) {
            val result = executeCommand(command, values)
            runOnUiThread {
                result.newSenderUrl?.let {
                    prefs.edit().putString("senderUrl", it).apply()
                    refreshVisibleSenderUrl(it)
                }
                renderStatus(result.status)
                latestOutput.text = result.output
                appendHistory(result.output)
            }
        }
    }

    /**
     * Handles execute command.
     * @param command Command text.
     * @param values Values to process.
     */
    private fun executeCommand(command: CommandSpec, values: Map<String, String>): CommandResult =
        when (command.id) {
            "coord.local.start" -> {
                val response = embeddedCoordNode.start(
                    paramNodeName(values),
                    paramLocalPort(values)
                )
                val senderUrl = response.optString("senderUrl").ifBlank {
                    embeddedCoordNode.currentSenderUrl().orEmpty()
                }
                CommandResult(
                    status = "Local node started",
                    output =
                    buildString {
                        appendLine("Local embedded coord started")
                        appendLine("Node: ${response.optString("nodeId")}")
                        appendLine("Epoch: ${response.optString("nodeEpoch")}")
                        appendLine("Sender URL: $senderUrl")
                        appendLine("Addrs:")
                        append(prettyValue(response.opt("addrs")))
                    }.trim(),
                    newSenderUrl = senderUrl.ifBlank { null }
                )
            }

            "coord.local.status" -> {
                val response = embeddedCoordNode.localStatus()
                CommandResult(
                    status = if (response.optBoolean(
                            "running",
                            false
                        )
                    ) {
                        "Local node running"
                    } else {
                        "Local node stopped"
                    },
                    output = prettyValue(response)
                )
            }

            "coord.local.stop" -> {
                val response = embeddedCoordNode.stop()
                CommandResult(status = "Local node stopped", output = prettyValue(response))
            }

            "coord.local.useSender" -> {
                val senderUrl = embeddedCoordNode.currentSenderUrl()
                    ?: throw IllegalStateException("Local Android coord node is not running")
                CommandResult(
                    status = "Using local sender URL",
                    output = senderUrl,
                    newSenderUrl = senderUrl
                )
            }

            "coord.health" -> {
                val senderUrl = paramSenderUrl(values)
                val started = System.currentTimeMillis()
                val (status, body) = rpcClient.health(senderUrl, paramTimeoutMs(values))
                val elapsed = System.currentTimeMillis() - started
                recordEvent("health", "status=$status sender=$senderUrl")
                CommandResult(
                    status = "Sender health ok",
                    output =
                    buildString {
                        appendLine("Probe sender /healthz (${elapsed}ms)")
                        appendLine(
                            "URL: ${CoordRpcClient.normalizeSenderBaseUrl(senderUrl)}/healthz"
                        )
                        appendLine("HTTP: $status")
                        if (body.isNotBlank()) {
                            appendLine("Body:")
                            append(prettyTextMaybeJson(body))
                        }
                    }.trim()
                )
            }

            "coord.sender.whoami" -> runSenderRpcCommand(
                "Sender whoami",
                values,
                "cord.foundation.whoami",
                JSONObject()
            )
            "coord.target.whoami" -> runTargetRpcCommand(
                "Target whoami",
                values,
                "cord.foundation.whoami",
                JSONObject()
            )
            "coord.target.ping" -> runTargetRpcCommand(
                "Ping target",
                values,
                "cord.foundation.ping",
                JSONObject()
            )
            "coord.peers" -> runRoutedRpcCommand(
                "Show peers",
                values,
                "cord.foundation.peers",
                JSONObject(),
                optionalTarget(values)
            )
            "coord.routes" -> runRoutedRpcCommand(
                "Show routes",
                values,
                "cord.foundation.routes",
                JSONObject(),
                optionalTarget(values)
            )

            "coord.connect" -> {
                val senderUrl = paramSenderUrl(values)
                val target = requireExecTarget(values)
                val params = JSONObject().put("target", CoordRpcClient.parseExecTarget(target))
                paramTtlMsOrNull(values)?.let { params.put("ttlMs", it) }
                runDirectRpcCommand(
                    "Connect target",
                    senderUrl,
                    "cord.foundation.connect",
                    params,
                    paramTimeoutMs(values)
                )
            }

            "coord.learn" -> {
                val senderUrl = paramSenderUrl(values)
                val target = requireExecTarget(values)
                val params = JSONObject().put("target", CoordRpcClient.parseExecTarget(target))
                runDirectRpcCommand(
                    "Learn target",
                    senderUrl,
                    "cord.foundation.learn",
                    params,
                    paramTimeoutMs(values)
                )
            }

            "coord.disconnect" -> {
                val senderUrl = paramSenderUrl(values)
                val targetNodeId = requireNodeAlias(values, "target", "Target")
                val params = JSONObject().put("targetNodeId", targetNodeId)
                runDirectRpcCommand(
                    "Disconnect target",
                    senderUrl,
                    "cord.foundation.disconnect",
                    params,
                    paramTimeoutMs(values)
                )
            }

            "coord.route.add" -> {
                val senderUrl = paramSenderUrl(values)
                val targetNodeId = requireNodeAlias(values, "target", "Target")
                val proxyNodeId = optionalNodeAlias(values, "proxyNode", "Proxy")
                val params = JSONObject().put(
                    "op",
                    "add"
                ).put("targetNodeId", targetNodeId).put("proxyNodeId", proxyNodeId)
                runDirectRpcCommand(
                    "Route add",
                    senderUrl,
                    "cord.foundation.route",
                    params,
                    paramTimeoutMs(values)
                )
            }

            "coord.route.del" -> {
                val senderUrl = paramSenderUrl(values)
                val targetNodeId = requireNodeAlias(values, "target", "Target")
                val params = JSONObject().put("op", "del").put("targetNodeId", targetNodeId)
                runDirectRpcCommand(
                    "Route delete",
                    senderUrl,
                    "cord.foundation.route",
                    params,
                    paramTimeoutMs(values)
                )
            }

            "coord.route.deny" -> {
                val senderUrl = paramSenderUrl(values)
                val targetNodeId = requireNodeAlias(values, "target", "Target")
                val direction = values["direction"].orEmpty().ifBlank { "both" }
                val params = JSONObject().put(
                    "op",
                    "deny"
                ).put("targetNodeId", targetNodeId).put("direction", direction)
                runDirectRpcCommand(
                    "Route deny $direction",
                    senderUrl,
                    "cord.foundation.route",
                    params,
                    paramTimeoutMs(values)
                )
            }

            "coord.proxy.on" -> {
                val senderUrl = paramSenderUrl(values)
                val targetNodeId = requireNodeAlias(values, "target", "Target")
                val params = JSONObject().put("enabled", true).put("defaultDstNodeId", targetNodeId)
                runDirectRpcCommand(
                    "Proxy on",
                    senderUrl,
                    "cord.foundation.proxy",
                    params,
                    paramTimeoutMs(values)
                )
            }

            "coord.proxy.off" -> {
                val senderUrl = paramSenderUrl(values)
                val params = JSONObject().put("enabled", false)
                runDirectRpcCommand(
                    "Proxy off",
                    senderUrl,
                    "cord.foundation.proxy",
                    params,
                    paramTimeoutMs(values)
                )
            }

            "coord.exec" -> {
                val params = JSONObject().put("command", paramExecCommand(values))
                paramOnlyOs(values)?.let { params.put("onlyOs", JSONArray(it)) }
                runRoutedRpcCommand(
                    "Exec shell command",
                    values,
                    "cord.foundation.execCommand",
                    params,
                    optionalTarget(values)
                )
            }

            "coord.echo" -> {
                val params = JSONObject()
                    .put("args", JSONArray().put(paramEchoText(values)))
                    .put("named", JSONObject())
                runRoutedRpcCommand(
                    "Echo",
                    values,
                    "cord.foundation.echo",
                    params,
                    optionalTarget(values)
                )
            }

            "coord.sleep" -> {
                val params = JSONObject().put("ms", paramSleepMs(values))
                runRoutedRpcCommand(
                    "Sleep",
                    values,
                    "cord.foundation.sleep",
                    params,
                    optionalTarget(values)
                )
            }

            "coord.raw.sender" -> {
                val senderUrl = paramSenderUrl(values)
                val method = paramRawMethod(values)
                val params = parseJsonValue(values["rawParams"].orEmpty())
                runDirectRpcCommand(
                    "Raw call $method",
                    senderUrl,
                    method,
                    params,
                    paramTimeoutMs(values)
                )
            }

            "coord.raw.target" -> {
                val method = paramRawMethod(values)
                val params = parseJsonValue(values["rawParams"].orEmpty())
                runTargetRpcCommand("Raw call $method", values, method, params)
            }

            "coord.copyVps" -> {
                val node = paramNodeName(values)
                val proxy = optionalNodeAlias(values, "proxyNode", "Proxy") ?: "P"
                val commands = buildString {
                    appendLine("coord @D -learn @$proxy")
                    appendLine("coord @D -route:add @$node @$proxy")
                    append("coord @D -echo @$node \"hello from D\"")
                }
                runOnUiThread {
                    val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("coord_vps_commands", commands))
                    Toast.makeText(
                        this,
                        "Copied VPS commands for @$node",
                        Toast.LENGTH_SHORT
                    ).show()
                }
                CommandResult(status = "Copied VPS commands", output = commands)
            }

            "steng.sqlite.smoke" -> {
                val now = System.currentTimeMillis()
                val db = databaseHelper.writableDatabase
                db.execSQL(
                    "INSERT INTO probe_events(created_at_ms, kind, detail) VALUES (?, ?, ?)",
                    arrayOf(now, "sqlite", "local smoke test")
                )
                val cursor = db.rawQuery(
                    "SELECT COUNT(*), MAX(created_at_ms) FROM probe_events",
                    emptyArray()
                )
                cursor.use {
                    it.moveToFirst()
                    val count = it.getLong(0)
                    val latest = it.getLong(1)
                    CommandResult(
                        status = "SQLite smoke test ok",
                        output = "SQLite ok. db=${getDatabasePath(
                            TesterDatabaseHelper.DB_NAME
                        ).absolutePath}, rows=$count, latest=$latest"
                    )
                }
            }

            "steng.ensureTable" -> {
                val response = embeddedCoordNode.localStengEnsureTable(
                    paramStengApp(values),
                    paramStengDb(values),
                    paramStengTable(values)
                )
                CommandResult(status = "Local steng table ready", output = prettyValue(response))
            }

            "steng.addDoc" -> {
                val response = embeddedCoordNode.localStengAddDoc(
                    paramStengApp(values),
                    paramStengDb(values),
                    paramStengTable(values),
                    paramStengJson(values)
                )
                CommandResult(status = "Local steng document added", output = prettyValue(response))
            }

            "steng.listDocs" -> {
                val response = embeddedCoordNode.localStengListDocs(
                    paramStengApp(values),
                    paramStengDb(values),
                    paramStengTable(values)
                )
                CommandResult(
                    status = "Local steng documents loaded",
                    output = prettyValue(response)
                )
            }

            else -> throw IllegalStateException("Unknown command ${command.id}")
        }

    /**
     * Runs sender RPC command.
     * @param label Label.
     * @param values Values to process.
     * @param method Method.
     * @param params SQL parameters.
     */
    private fun runSenderRpcCommand(
        label: String,
        values: Map<String, String>,
        method: String,
        params: Any
    ): CommandResult =
        runDirectRpcCommand(label, paramSenderUrl(values), method, params, paramTimeoutMs(values))

    /**
     * Runs target RPC command.
     * @param label Label.
     * @param values Values to process.
     * @param method Method.
     * @param params SQL parameters.
     */
    private fun runTargetRpcCommand(
        label: String,
        values: Map<String, String>,
        method: String,
        params: Any
    ): CommandResult = runRoutedRpcCommand(label, values, method, params, requireExecTarget(values))

    /**
     * Runs routed RPC command.
     * @param label Label.
     * @param values Values to process.
     * @param method Method.
     * @param params SQL parameters.
     * @param targetText Target text.
     */
    private fun runRoutedRpcCommand(
        label: String,
        values: Map<String, String>,
        method: String,
        params: Any,
        targetText: String?
    ): CommandResult {
        val senderUrl = paramSenderUrl(values)
        val started = System.currentTimeMillis()
        val response = rpcClient.execute(
            senderUrl,
            method,
            params,
            targetText,
            paramTimeoutMs(values)
        )
        val elapsed = System.currentTimeMillis() - started
        recordEvent("rpc", "$label sender=$senderUrl target=${targetText.orEmpty()}")
        return CommandResult(
            status = "$label ok",
            output = formatRpcResponse(label, response, elapsed)
        )
    }

    /**
     * Runs direct RPC command.
     * @param label Label.
     * @param senderUrl Sender url.
     * @param method Method.
     * @param params SQL parameters.
     * @param timeoutMs Timeout ms.
     */
    private fun runDirectRpcCommand(
        label: String,
        senderUrl: String,
        method: String,
        params: Any,
        timeoutMs: Int
    ): CommandResult {
        val started = System.currentTimeMillis()
        val response = rpcClient.call(senderUrl, method, params, timeoutMs)
        val elapsed = System.currentTimeMillis() - started
        recordEvent("rpc", "$label sender=$senderUrl")
        return CommandResult(
            status = "$label ok",
            output = formatRpcResponse(label, response, elapsed)
        )
    }

    /**
     * Runs background action.
     * @param label Label.
     * @param action Permission action.
     */
    private fun runBackgroundAction(label: String, action: () -> Unit) {
        renderStatus("Running $label")
        executor.execute {
            try {
                action()
            } catch (error: Throwable) {
                runOnUiThread {
                    renderStatus("$label failed")
                    latestOutput.text = error.message ?: error.toString()
                    appendHistory("$label failed\n${error.message ?: error}")
                }
            }
        }
    }

    /**
     * Handles render status.
     * @param status Status.
     */
    private fun renderStatus(status: String) {
        statusOutput.text = "Status: $status"
        val localStatus = embeddedCoordNode.localStatus()
        val localSenderUrl = embeddedCoordNode.currentSenderUrl()
        contextOutput.text = buildString {
            appendLine("Selected app: ${currentApp.label}")
            appendLine("Selected command: ${currentCommand?.label ?: "(none)"}")
            appendLine(
                "Local node running: ${if (localStatus.optBoolean(
                        "running",
                        false
                    )
                ) {
                    "yes"
                } else {
                    "no"
                }}"
            )
            appendLine("Local sender URL: ${localSenderUrl ?: "(not running)"}")
            appendLine(
                "Saved sender URL: ${prefs.getString(
                    "senderUrl",
                    "http://157.250.198.83:4001"
                ).orEmpty()}"
            )
            appendLine("Package: $packageName")
            appendLine("Version: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            append("DB path: ${getDatabasePath(TesterDatabaseHelper.DB_NAME).absolutePath}")
        }.trim()
    }

    /**
     * Handles append history.
     * @param entry Entry.
     */
    private fun appendHistory(entry: String) {
        val prefix = historyOutput.text.toString().trim().takeIf {
            it !=
                getString(R.string.history_placeholder)
        }.orEmpty()
        historyOutput.text = if (prefix.isBlank()) {
            entry
        } else {
            "$entry\n\n$prefix"
        }
    }

    /**
     * Handles collect visible values.
     */
    private fun collectVisibleValues(): Map<String, String> = visibleParamInputs.mapValues {
        it.value.text.toString()
    }

    /**
     * Handles persist visible inputs.
     */
    private fun persistVisibleInputs() {
        persistValues(collectVisibleValues())
    }

    /**
     * Handles persist values.
     * @param values Values to process.
     */
    private fun persistValues(values: Map<String, String>) {
        val editor = prefs.edit()
        values.forEach { (key, value) ->
            currentCommand?.params?.firstOrNull {
                it.key == key
            }?.let { editor.putString(it.prefKey, value) }
        }
        editor.apply()
    }

    /**
     * Handles refresh visible sender url.
     * @param newValue New value.
     */
    private fun refreshVisibleSenderUrl(newValue: String? = embeddedCoordNode.currentSenderUrl()) {
        val senderField = visibleParamInputs["senderUrl"] ?: return
        val senderUrl = newValue ?: return
        senderField.setText(senderUrl)
    }

    /**
     * Handles selected command pref key.
     * @param app Application name.
     */
    private fun selectedCommandPrefKey(app: TestedApp): String = "selectedCommand.${app.id}"

    /**
     * Handles param node name.
     * @param values Values to process.
     */
    private fun paramNodeName(values: Map<String, String>): String =
        values["nodeName"]?.trim().takeUnless { it.isNullOrBlank() }
            ?: prefs.getString("nodeName", "A").orEmpty().ifBlank { "A" }

    /**
     * Handles param local port.
     * @param values Values to process.
     */
    private fun paramLocalPort(values: Map<String, String>): Int {
        val raw = values["localPort"]?.trim().orEmpty().ifBlank { "4001" }
        return raw.toIntOrNull()?.takeIf { it in 1..65535 }
            ?: throw IllegalArgumentException("Local port must be between 1 and 65535")
    }

    /**
     * Handles param sender url.
     * @param values Values to process.
     */
    private fun paramSenderUrl(values: Map<String, String>): String =
        values["senderUrl"]?.trim().takeUnless { it.isNullOrBlank() }
            ?: prefs.getString("senderUrl", "http://157.250.198.83:4001").orEmpty()

    /**
     * Handles optional target.
     * @param values Values to process.
     */
    private fun optionalTarget(values: Map<String, String>): String? =
        CoordRpcClient.normalizeTargetText(values["target"]).ifBlank { null }

    /**
     * Handles require exec target.
     * @param values Values to process.
     */
    private fun requireExecTarget(values: Map<String, String>): String =
        optionalTarget(values) ?: throw IllegalArgumentException("Target is empty")

    /**
     * Handles require node alias.
     * @param values Values to process.
     * @param key Key.
     * @param label Label.
     */
    private fun requireNodeAlias(values: Map<String, String>, key: String, label: String): String {
        val value = CoordRpcClient.normalizeTargetText(values[key]).ifBlank {
            throw IllegalArgumentException("$label is empty")
        }
        require(!CoordRpcClient.looksLikeAddr(value)) {
            "$label must be a node name, not a host:port"
        }
        return value
    }

    /**
     * Handles optional node alias.
     * @param values Values to process.
     * @param key Key.
     * @param label Label.
     */
    private fun optionalNodeAlias(
        values: Map<String, String>,
        key: String,
        label: String
    ): String? {
        val value = CoordRpcClient.normalizeTargetText(values[key]).ifBlank { return null }
        require(!CoordRpcClient.looksLikeAddr(value)) {
            "$label must be a node name, not a host:port"
        }
        return value
    }

    /**
     * Handles param TTL ms or null.
     * @param values Values to process.
     */
    private fun paramTtlMsOrNull(values: Map<String, String>): Int? {
        val raw = values["ttlSeconds"]?.trim().orEmpty()
        if (raw.isBlank()) {
            return null
        }
        val seconds =
            raw.toIntOrNull() ?: throw IllegalArgumentException("TTL seconds must be an integer")
        return seconds * 1000
    }

    /**
     * Handles param timeout ms.
     * @param values Values to process.
     */
    private fun paramTimeoutMs(values: Map<String, String>): Int {
        val raw = values["timeoutSeconds"]?.trim().orEmpty().ifBlank { "10" }
        val seconds = raw.toIntOrNull() ?: 10
        return (if (seconds <= 0) 10 else seconds) * 1000
    }

    /**
     * Handles param echo text.
     * @param values Values to process.
     */
    private fun paramEchoText(values: Map<String, String>): String =
        values["echoText"]?.trim().takeUnless { it.isNullOrBlank() } ?: "hello from app_tester"

    /**
     * Handles param exec command.
     * @param values Values to process.
     */
    private fun paramExecCommand(values: Map<String, String>): String =
        values["execCommand"]?.trim().takeUnless { it.isNullOrBlank() }
            ?: throw IllegalArgumentException("Shell command is empty")

    /**
     * Handles param only OS.
     * @param values Values to process.
     */
    private fun paramOnlyOs(values: Map<String, String>): List<String>? {
        val raw = values["onlyOs"]?.trim().orEmpty()
        if (raw.isBlank()) {
            return null
        }
        return raw.split(",").map { it.trim().lowercase() }.filter { it.isNotEmpty() }
    }

    /**
     * Handles param sleep ms.
     * @param values Values to process.
     */
    private fun paramSleepMs(values: Map<String, String>): Int {
        val raw = values["sleepMs"]?.trim().orEmpty().ifBlank { "200" }
        return raw.toIntOrNull()?.takeIf { it >= 0 } ?: 200
    }

    /**
     * Handles param steng application.
     * @param values Values to process.
     */
    private fun paramStengApp(values: Map<String, String>): String =
        values["stengApp"]?.trim().takeUnless { it.isNullOrBlank() } ?: "demo"

    /**
     * Handles param steng database.
     * @param values Values to process.
     */
    private fun paramStengDb(values: Map<String, String>): String =
        values["stengDb"]?.trim().takeUnless { it.isNullOrBlank() } ?: "main"

    /**
     * Handles param steng table.
     * @param values Values to process.
     */
    private fun paramStengTable(values: Map<String, String>): String =
        values["stengTable"]?.trim().takeUnless { it.isNullOrBlank() } ?: "notes"

    /**
     * Handles param steng JSON.
     * @param values Values to process.
     */
    private fun paramStengJson(values: Map<String, String>): String =
        values["stengJson"]?.trim().takeUnless { it.isNullOrBlank() } ?: "{}"

    /**
     * Handles param raw method.
     * @param values Values to process.
     */
    private fun paramRawMethod(values: Map<String, String>): String =
        values["rawMethod"]?.trim().takeUnless { it.isNullOrBlank() }
            ?: throw IllegalArgumentException("Raw method is empty")

    /**
     * Parses JSON value.
     * @param raw Raw.
     */
    private fun parseJsonValue(raw: String): Any {
        val text = raw.trim()
        if (text.isBlank()) {
            return JSONObject()
        }
        return JSONTokener(text).nextValue()
    }

    /**
     * Formats RPC response.
     * @param label Label.
     * @param response Response.
     * @param elapsedMs Elapsed ms.
     */
    private fun formatRpcResponse(label: String, response: JSONObject, elapsedMs: Long): String {
        val contactedNode = response.optJSONObject("node")?.optString("nodeId")?.takeIf {
            it.isNotBlank()
        }
        val result = response.opt("result")
        return buildString {
            appendLine("$label (${elapsedMs}ms)")
            if (contactedNode != null) {
                appendLine("Contacted: $contactedNode")
            }
            if (result is JSONObject && result.has("route") && result.has("result")) {
                val route = result.optJSONObject("route")
                if (route != null) {
                    appendLine("Path: ${CoordRpcClient.renderRoute(route)}")
                    appendLine("Mode: ${route.optString("mode", "unknown")}")
                }
                appendLine("Result:")
                append(prettyValue(result.opt("result")))
            } else {
                appendLine("Result:")
                append(prettyValue(result))
            }
        }.trim()
    }

    /**
     * Handles pretty value.
     * @param value Value to process.
     */
    private fun prettyValue(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.toString(2)
        is JSONArray -> value.toString(2)
        is String -> prettyTextMaybeJson(value)
        else -> value.toString()
    }

    /**
     * Handles pretty text maybe JSON.
     * @param text Text value.
     */
    private fun prettyTextMaybeJson(text: String): String {
        val trimmed = text.trim()
        if (trimmed.isBlank()) {
            return ""
        }
        return try {
            when (val parsed = JSONTokener(trimmed).nextValue()) {
                is JSONObject -> parsed.toString(2)
                is JSONArray -> parsed.toString(2)
                else -> parsed?.toString() ?: "null"
            }
        } catch (_: Throwable) {
            trimmed
        }
    }

    /**
     * Handles record event.
     * @param kind Kind.
     * @param detail Detail.
     */
    private fun recordEvent(kind: String, detail: String) {
        databaseHelper.writableDatabase.execSQL(
            "INSERT INTO probe_events(created_at_ms, kind, detail) VALUES (?, ?, ?)",
            arrayOf(System.currentTimeMillis(), kind, detail)
        )
    }

    /**
     * Handles guarded.
     * @param action Permission action.
     */
    private fun guarded(action: () -> Unit) {
        try {
            action()
        } catch (error: Throwable) {
            renderStatus("Input error")
            latestOutput.text = error.message ?: error.toString()
            appendHistory(error.message ?: error.toString())
        }
    }

    /**
     * Handles show help.
     * @param title Title.
     * @param message Message.
     */
    private fun showHelp(title: String, message: String) {
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    /**
     * Handles dp.
     * @param value Value to process.
     */
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /**
     * Builds command specs.
     */
    private fun buildCommandSpecs(): List<CommandSpec> {
        val nodeName = ParamSpec(
            key = "nodeName",
            label = "Node alias",
            hint = getString(R.string.node_name_hint),
            help =
            "Short local node name used in playground-style commands " +
                "and VPS route examples.",
            prefKey = "nodeName",
            defaultValue = "A"
        )
        val localPort = ParamSpec(
            key = "localPort",
            label = "Local port",
            hint = getString(R.string.local_port_hint),
            help = "TCP port for the embedded Android coord node listener inside this app process.",
            prefKey = "localPort",
            defaultValue = "4001",
            inputType = InputType.TYPE_CLASS_NUMBER
        )
        val senderUrl = ParamSpec(
            key = "senderUrl",
            label = "Sender URL",
            hint = getString(R.string.sender_url_hint),
            help =
            "Base URL of the coord sender you want to call, for example " +
                "http://157.250.198.83:4001.",
            prefKey = "senderUrl",
            defaultValue = "http://157.250.198.83:4001",
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        )
        val target = ParamSpec(
            key = "target",
            label = "Target",
            hint = getString(R.string.target_hint),
            help =
            "Node alias or host:port to execute on. Leave blank for " +
                "sender-local commands like peers/routes on the sender.",
            prefKey = "target",
            defaultValue = "A",
            optional = true
        )
        val proxyNode = ParamSpec(
            key = "proxyNode",
            label = "Proxy node",
            hint = getString(R.string.proxy_node_hint),
            help = "Proxy node alias used for route add and VPS helper command generation.",
            prefKey = "proxyNode",
            defaultValue = "P",
            optional = true
        )
        val ttlSeconds = ParamSpec(
            key = "ttlSeconds",
            label = "TTL seconds",
            hint = getString(R.string.ttl_seconds_hint),
            help =
            "Blank means persistent forever. 0 means runtime only. " +
                "Positive values persist until they expire.",
            prefKey = "ttlSeconds",
            defaultValue = "",
            inputType = InputType.TYPE_CLASS_NUMBER,
            optional = true
        )
        val timeoutSeconds = ParamSpec(
            key = "timeoutSeconds",
            label = "Timeout seconds",
            hint = getString(R.string.timeout_seconds_hint),
            help = "RPC timeout used by the phone app when it talks to coord senders.",
            prefKey = "timeoutSeconds",
            defaultValue = "10",
            inputType = InputType.TYPE_CLASS_NUMBER
        )
        val echoText = ParamSpec(
            key = "echoText",
            label = "Echo text",
            hint = getString(R.string.echo_hint),
            help = "Message passed to cord.foundation.echo.",
            prefKey = "echoText",
            defaultValue = "hello from app_tester"
        )
        val execCommand = ParamSpec(
            key = "execCommand",
            label = "Shell command",
            hint = getString(R.string.exec_command_hint),
            help =
            "Console command executed on the sender or routed target. " +
                "Android nodes report unsupported; Linux and Windows " +
                "Node runtimes can execute it.",
            prefKey = "execCommand",
            defaultValue = "uname -a"
        )
        val onlyOs = ParamSpec(
            key = "onlyOs",
            label = "Only OS",
            hint = getString(R.string.only_os_hint),
            help =
            "Optional comma-separated OS filter. If the remote host OS " +
                "does not match, the command is skipped instead of executed.",
            prefKey = "onlyOs",
            defaultValue = "",
            optional = true
        )
        val sleepMs = ParamSpec(
            key = "sleepMs",
            label = "Sleep ms",
            hint = getString(R.string.sleep_ms_hint),
            help = "Milliseconds passed to cord.foundation.sleep.",
            prefKey = "sleepMs",
            defaultValue = "200",
            inputType = InputType.TYPE_CLASS_NUMBER
        )
        val rawMethod = ParamSpec(
            key = "rawMethod",
            label = "Raw method",
            hint = getString(R.string.raw_method_hint),
            help =
            "Any RPC method name. Use this when the guided command list " +
                "does not cover a foundation/cluster/IAM method yet.",
            prefKey = "rawMethod",
            defaultValue = "cord.foundation.whoami"
        )
        val rawParams = ParamSpec(
            key = "rawParams",
            label = "Raw JSON params",
            hint = getString(R.string.raw_params_hint),
            help = "JSON params object or array passed to the raw RPC method.",
            prefKey = "rawParams",
            defaultValue = "{}",
            multiline = true
        )
        val stengApp = ParamSpec(
            key = "stengApp",
            label = "Steng app",
            hint = getString(R.string.steng_app_hint),
            help = "Logical app scope for the embedded Android steng tables.",
            prefKey = "stengApp",
            defaultValue = "demo"
        )
        val stengDb = ParamSpec(
            key = "stengDb",
            label = "Steng db",
            hint = getString(R.string.steng_db_hint),
            help = "Logical db scope for the embedded Android steng tables.",
            prefKey = "stengDb",
            defaultValue = "main"
        )
        val stengTable = ParamSpec(
            key = "stengTable",
            label = "Steng table",
            hint = getString(R.string.steng_table_hint),
            help = "Table name to create or read inside the embedded Android steng playground.",
            prefKey = "stengTable",
            defaultValue = "notes"
        )
        val stengJson = ParamSpec(
            key = "stengJson",
            label = "JSON document",
            hint = getString(R.string.steng_json_hint),
            help = "JSON document added as a local steng row.",
            prefKey = "stengJson",
            defaultValue = "{\"title\":\"hello\",\"tags\":[\"android\",\"demo\"]}",
            multiline = true
        )
        val direction = ParamSpec(
            key = "direction",
            label = "Direction",
            hint = "in, out, or both",
            help = "Which direction to deny for the selected target in the sender's route table.",
            prefKey = "routeDirection",
            defaultValue = "both"
        )

        return listOf(
            CommandSpec(
                TestedApp.COORD,
                "coord.local.start",
                "Local: Start embedded node",
                "Start the real embedded Android coord node in this app and " +
                    "auto-save its local sender URL.",
                listOf(nodeName, localPort)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.local.status",
                "Local: Show node status",
                "Show whether the embedded Android coord node is currently " +
                    "running and what it is listening on.",
                emptyList()
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.local.stop",
                "Local: Stop embedded node",
                "Stop the embedded Android coord node in this app process.",
                emptyList()
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.local.useSender",
                "Local: Use local sender URL",
                "Point sender URL to the currently running embedded Android coord node.",
                emptyList()
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.health",
                "Network: Probe sender /healthz",
                "Run the sender health check and show the raw healthz response.",
                listOf(senderUrl, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.sender.whoami",
                "Foundation: Sender whoami",
                "Call cord.foundation.whoami directly on the selected sender URL.",
                listOf(senderUrl, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.target.whoami",
                "Foundation: Target whoami",
                "Ask the sender to execute whoami on the selected target.",
                listOf(senderUrl, target, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.target.ping",
                "Foundation: Ping target",
                "Ask the sender to execute ping on the selected target.",
                listOf(senderUrl, target, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.peers",
                "Foundation: Show peers",
                "Show the peer table on the sender or, if target is set, on " +
                    "that target through the sender.",
                listOf(senderUrl, target, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.routes",
                "Foundation: Show routes",
                "Show the route table on the sender or, if target is set, on " +
                    "that target through the sender.",
                listOf(senderUrl, target, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.connect",
                "Foundation: Connect target",
                "Create a learned or persistent connection to the target. " +
                    "Blank TTL persists forever; 0 is runtime only.",
                listOf(senderUrl, target, ttlSeconds, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.learn",
                "Foundation: Learn target",
                "Ask the sender to learn peer details from the target.",
                listOf(senderUrl, target, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.disconnect",
                "Foundation: Disconnect target",
                "Remove a saved connection intent for the selected target node on the sender.",
                listOf(senderUrl, target, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.route.add",
                "Routing: Add route",
                "Add an explicit route to the target, optionally via the proxy node.",
                listOf(senderUrl, target, proxyNode, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.route.del",
                "Routing: Delete route",
                "Delete the explicit route entry for the selected target.",
                listOf(senderUrl, target, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.route.deny",
                "Routing: Deny route direction",
                "Apply a deny rule for the selected target in the sender's route table.",
                listOf(senderUrl, target, direction, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.proxy.on",
                "Routing: Proxy on",
                "Turn on proxy mode and use the selected target as the default destination.",
                listOf(senderUrl, target, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.proxy.off",
                "Routing: Proxy off",
                "Turn off proxy mode on the sender.",
                listOf(senderUrl, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.exec",
                "Foundation: Exec shell command",
                "Execute a console command on the sender or routed target. " +
                    "Android app nodes return unsupported; Linux and Windows " +
                    "nodes execute it.",
                listOf(senderUrl, target, execCommand, onlyOs, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.echo",
                "Foundation: Echo",
                "Run cord.foundation.echo on the sender or on the selected target.",
                listOf(senderUrl, target, echoText, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.sleep",
                "Foundation: Sleep",
                "Run cord.foundation.sleep on the sender or on the selected target.",
                listOf(senderUrl, target, sleepMs, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.raw.sender",
                "Advanced: Raw call on sender",
                "Run any RPC method directly on the sender.",
                listOf(senderUrl, rawMethod, rawParams, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.raw.target",
                "Advanced: Raw call on target",
                "Run any RPC method on the selected target through the sender.",
                listOf(senderUrl, target, rawMethod, rawParams, timeoutSeconds)
            ),
            CommandSpec(
                TestedApp.COORD,
                "coord.copyVps",
                "Helper: Copy VPS route commands",
                "Copy the Linux playground CLI commands needed on the VPS for " +
                    "D -> P -> A routing tests.",
                listOf(nodeName, proxyNode)
            ),
            CommandSpec(
                TestedApp.STENG,
                "steng.sqlite.smoke",
                "SQLite: Smoke test",
                "Verify that the app can write to and read from the shared local SQLite database.",
                emptyList()
            ),
            CommandSpec(
                TestedApp.STENG,
                "steng.ensureTable",
                "Steng: Ensure table",
                "Create or update the selected local steng table.",
                listOf(stengApp, stengDb, stengTable)
            ),
            CommandSpec(
                TestedApp.STENG,
                "steng.addDoc",
                "Steng: Add document",
                "Insert a JSON document into the selected local steng table.",
                listOf(stengApp, stengDb, stengTable, stengJson)
            ),
            CommandSpec(
                TestedApp.STENG,
                "steng.listDocs",
                "Steng: List documents",
                "List documents from the selected local steng table.",
                listOf(stengApp, stengDb, stengTable)
            )
        )
    }
}
