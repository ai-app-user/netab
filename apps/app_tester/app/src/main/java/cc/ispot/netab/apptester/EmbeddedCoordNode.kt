package cc.ispot.netab.apptester

import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.net.HttpURLConnection
import java.net.NetworkInterface
import java.net.URL
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * In-process Android-hosted coord node used by `app_tester`.
 *
 * It intentionally mirrors the Linux Node runtime closely enough to test peer
 * learning, routing, persistent connects, and a minimal SQLite-backed `steng`
 * playground while staying inside one Android app process.
 */
class EmbeddedCoordNode private constructor(private val db: TesterDatabaseHelper) {
    private val lock = Any()
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    @Volatile
    private var server: CoordHttpServer? = null

    @Volatile
    private var localNode: LocalNode? = null

    private val reverseIncoming = ConcurrentHashMap<String, ReverseIncomingSession>()
    private val reverseOutgoing = ConcurrentHashMap<String, ReverseOutgoingConnection>()

    /** True when both local node state and the HTTP listener are active. */
    fun isRunning(): Boolean = localNode != null && server != null

    /** Base sender URL that other playground actions should use for this node. */
    fun currentSenderUrl(): String? = localNode?.let { "http://127.0.0.1:${it.port}" }

    /** Start or replace the embedded node listener and optionally replay saved links. */
    fun start(nodeId: String, port: Int, autoRestoreConnections: Boolean = true): JSONObject {
        require(nodeId.isNotBlank()) { "Node id is empty" }
        require(port in 1..65535) { "Port must be between 1 and 65535" }

        synchronized(lock) {
            stopInternal()

            val nodeEpoch = db.getJsonState("coord.local.nodeEpoch.$nodeId.$port")
                ?.takeIf { it.isNotBlank() }
                ?: "epoch_${System.currentTimeMillis()}_${UUID.randomUUID().toString().replace(
                    "-",
                    ""
                ).take(12)}"
            db.putJsonState("coord.local.nodeEpoch.$nodeId.$port", nodeEpoch)

            val advertiseAddrs = discoverAdvertiseAddrs(port)
            val node = LocalNode(
                nodeId = nodeId,
                nodeEpoch = nodeEpoch,
                port = port,
                listenAddrs = listOf("0.0.0.0:$port", "127.0.0.1:$port"),
                addrs = advertiseAddrs,
                props = JSONObject().put(
                    "type",
                    "android"
                ).put(
                    "osType",
                    "android"
                ).put("execSupported", false).put("priority", 1).put("leaseMs", 1500)
            )
            val http = CoordHttpServer(port, this)
            try {
                http.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            } catch (error: IOException) {
                throw IllegalStateException(
                    "Failed to start local node on port $port: ${error.message}",
                    error
                )
            }
            localNode = node
            server = http
            saveLocalNodeConfig(LocalNodeConfigValue(nodeId = nodeId, port = port))
            persistRouteState(loadRouteState())
            if (autoRestoreConnections) {
                executor.execute {
                    try {
                        restorePersistentConnections()
                    } catch (_: Throwable) {
                    }
                }
            }

            return JSONObject()
                .put("ok", true)
                .put("nodeId", node.nodeId)
                .put("nodeEpoch", node.nodeEpoch)
                .put("senderUrl", currentSenderUrl())
                .put("port", port)
                .put("addrs", JSONArray(node.addrs))
        }
    }

    /** Stop the embedded node and close any live reverse-link state. */
    fun stop(): JSONObject {
        synchronized(lock) {
            stopInternal()
            return JSONObject().put("ok", true)
        }
    }

    /** Restore the last saved local node config and replay persistent connects. */
    fun autoRestore(): JSONObject? {
        val config = loadLocalNodeConfig() ?: return null
        val current = localNode
        if (current != null && server != null && current.nodeId == config.nodeId &&
            current.port == config.port
        ) {
            return localStatus()
                .put("ok", true)
                .put("restored", true)
                .put("senderUrl", currentSenderUrl())
        }
        return start(config.nodeId, config.port, autoRestoreConnections = true)
    }

    /** Return a diagnostic snapshot of the current local-node runtime. */
    fun localStatus(): JSONObject {
        val node = localNode
            ?: return JSONObject().put("running", false)
        return JSONObject()
            .put("running", true)
            .put("node", node.toJson())
            .put("senderUrl", currentSenderUrl())
            .put("persistentConnects", JSONArray(loadConnectIntents().map { it.label() }))
            .put("connectedPeers", JSONArray(reverseOutgoing.keys.sorted()))
    }

    /** Create or open one local SQLite-backed steng table. */
    fun localStengEnsureTable(
        app: String,
        dbName: String,
        tableName: String,
        type: String = "json"
    ): JSONObject {
        val tableId = db.ensureStengTable(
            app,
            dbName,
            tableName,
            type,
            JSONObject().put("indexes", JSONObject()).toString()
        )
        return JSONObject()
            .put("ok", true)
            .put("tableId", tableId)
            .put("app", app)
            .put("db", dbName)
            .put("tableName", tableName)
            .put("type", type)
    }

    /** Insert one local steng JSON row into the selected table. */
    fun localStengAddDoc(
        app: String,
        dbName: String,
        tableName: String,
        rawJson: String
    ): JSONObject {
        val tableId = db.findStengTable(app, dbName, tableName)
            ?: db.ensureStengTable(
                app,
                dbName,
                tableName,
                "json",
                JSONObject().put("indexes", JSONObject()).toString()
            )
        val normalized = prettyJson(rawJson)
        val nodeId = localNode?.nodeId ?: "android"
        val docId = "${tableName}_${nodeId}_${UUID.randomUUID()}"
        db.addOrReplaceStengDoc(tableId, docId, normalized, System.currentTimeMillis())
        return JSONObject()
            .put("ok", true)
            .put("tableId", tableId)
            .put("docId", docId)
            .put("value", JSONTokener(normalized).nextValue())
    }

    /** List live local steng docs for the selected table. */
    fun localStengListDocs(app: String, dbName: String, tableName: String): JSONObject {
        val tableId = db.findStengTable(app, dbName, tableName)
            ?: return JSONObject().put(
                "ok",
                true
            ).put("tableId", JSONObject.NULL).put("items", JSONArray())
        val items = JSONArray()
        for ((docId, rawValue) in db.listStengDocs(tableId)) {
            items.put(
                JSONObject()
                    .put("id", docId)
                    .put("value", JSONTokener(rawValue).nextValue())
            )
        }
        return JSONObject()
            .put("ok", true)
            .put("tableId", tableId)
            .put("items", items)
    }

    /** Handle inbound `/healthz` and `/rpc` requests served by the embedded node. */
    internal fun handleHttp(session: NanoHTTPD.IHTTPSession): NanoHTTPD.Response = try {
        when {
            session.method == NanoHTTPD.Method.GET && session.uri == "/healthz" -> jsonResponse(
                NanoHTTPD.Response.Status.OK,
                JSONObject()
                    .put("ok", true)
                    .put("node", requireLocalNode().toJson())
                    .put("pid", android.os.Process.myPid())
            )
            session.method == NanoHTTPD.Method.POST && session.uri == "/rpc" -> {
                val payload = readJsonBody(session)
                val method = payload.optString("method")
                if (method.isBlank()) {
                    jsonResponse(
                        NanoHTTPD.Response.Status.BAD_REQUEST,
                        JSONObject().put("ok", false).put("error", errorJson("Missing RPC method"))
                    )
                } else {
                    val ctx = RpcCtxValue(
                        auth = payload.optJSONObject("auth"),
                        srcNodeId = payload.optString("srcNodeId").ifBlank { null },
                        srcNodeInfo = payload.optJSONObject("srcNodeInfo")?.let {
                            NodeInfoValue.fromJson(it)
                        },
                        originNodeId = payload.optString("originNodeId").ifBlank { null },
                        traceId = payload.optString("traceId").ifBlank { null }
                    )
                    val result = dispatch(method, ctx, payload.opt("params"))
                    jsonResponse(
                        NanoHTTPD.Response.Status.OK,
                        JSONObject()
                            .put("ok", true)
                            .put("node", requireLocalNode().toJson())
                            .put("result", toJsonValue(result))
                    )
                }
            }
            else -> jsonResponse(
                NanoHTTPD.Response.Status.NOT_FOUND,
                JSONObject().put(
                    "ok",
                    false
                ).put("error", errorJson("Unknown route ${session.method} ${session.uri}"))
            )
        }
    } catch (error: Throwable) {
        jsonResponse(
            NanoHTTPD.Response.Status.INTERNAL_ERROR,
            JSONObject()
                .put("ok", false)
                .put("node", localNode?.toJson() ?: JSONObject.NULL)
                .put("error", errorJson(error.message ?: error.toString()))
        )
    }

    /**
     * Dispatches the request to the matching handler.
     * @param method Method.
     * @param ctx Execution context.
     * @param params SQL parameters.
     */
    private fun dispatch(method: String, ctx: RpcCtxValue, params: Any?): Any {
        learnInbound(ctx.srcNodeId, ctx.srcNodeInfo)
        learnProxyOrigin(ctx.originNodeId, ctx.srcNodeId)
        enforceInboundRoutePolicy(ctx.srcNodeId)
        return invokeHandler(method, ctx, params)
    }

    /**
     * Invokes the resolved handler and normalizes its result.
     * @param method Method.
     * @param ctx Execution context.
     * @param params SQL parameters.
     */
    private fun invokeHandler(method: String, ctx: RpcCtxValue, params: Any?): Any = when (method) {
        "cord.foundation.ping" -> JSONObject().put("ok", true)
        "cord.foundation.whoami" -> requireLocalNode().toJson()
        "cord.foundation.echo" -> foundationEcho(params)
        "cord.foundation.sleep" -> foundationSleep(params)
        "cord.foundation.execCommand" -> foundationExecCommand(params)
        "cord.foundation.exec" -> executeRouted(ctx, params as? JSONObject ?: JSONObject())
        "cord.foundation.peer.list" -> listPeerSummaries()
        "cord.foundation.peers" -> getPeerTable().toJson()
        "cord.foundation.routes" -> getRouteTable().toJson()
        "cord.foundation.connect" -> {
            val payload = params as? JSONObject ?: JSONObject()
            val target = ExecTargetValue.fromJson(payload.optJSONObject("target"))
                ?: throw IllegalArgumentException("connect requires a target")
            connect(
                target,
                if (payload.has("ttlMs") &&
                    !payload.isNull("ttlMs")
                ) {
                    payload.optLong("ttlMs", 0)
                } else {
                    null
                },
                payload.optBoolean("persist", !payload.has("ttlMs"))
            )
        }
        "cord.foundation.disconnect" -> {
            val payload = params as? JSONObject ?: JSONObject()
            disconnect(payload.optString("targetNodeId"))
        }
        "cord.foundation.restore" -> restorePersistentConnections()
        "cord.foundation.learn" -> {
            val payload = params as? JSONObject ?: JSONObject()
            val target = ExecTargetValue.fromJson(payload.optJSONObject("target"))
                ?: throw IllegalArgumentException("learn requires a target")
            learn(target)
        }
        "cord.foundation.route" -> routeOp(params as? JSONObject ?: JSONObject())
        "cord.foundation.proxy" -> proxyOp(params as? JSONObject ?: JSONObject())
        "cord.foundation.reverse.open" -> handleReverseOpen(
            ctx,
            params as? JSONObject ?: JSONObject()
        )
        "cord.foundation.reverse.poll" -> handleReversePoll(
            ctx,
            params as? JSONObject ?: JSONObject()
        )
        "cord.foundation.reverse.reply" -> handleReverseReply(
            ctx,
            params as? JSONObject ?: JSONObject()
        )
        "cord.foundation.reverse.close" -> handleReverseClose(
            ctx,
            params as? JSONObject ?: JSONObject()
        )
        else -> throw IllegalStateException("Unknown RPC method $method")
    }

    /**
     * Handles foundation exec command.
     * @param params SQL parameters.
     */
    private fun foundationExecCommand(params: Any?): JSONObject {
        val payload = params as? JSONObject ?: JSONObject()
        val command = payload.optString("command").trim()
        require(command.isNotEmpty()) { "execCommand requires a shell command" }
        val allowedOs = when {
            payload.has("onlyOs") && payload.optJSONArray("onlyOs") != null -> {
                val items = payload.optJSONArray("onlyOs") ?: JSONArray()
                buildList {
                    for (index in 0 until items.length()) {
                        val value = items.optString(index).trim().lowercase()
                        if (value.isNotEmpty()) {
                            add(value)
                        }
                    }
                }
            }
            payload.has("onlyOs") -> payload.optString("onlyOs").split(",").map {
                it.trim().lowercase()
            }.filter { it.isNotEmpty() }
            else -> emptyList()
        }
        if (allowedOs.isNotEmpty() && !allowedOs.contains("android")) {
            return JSONObject()
                .put("ok", true)
                .put("command", command)
                .put("osType", "android")
                .put("supported", false)
                .put("skipped", true)
                .put("reason", "OS android is not in allowed set ${allowedOs.joinToString(",")}")
                .put("exitCode", JSONObject.NULL)
                .put("signal", JSONObject.NULL)
                .put("timedOut", false)
                .put("stdout", "")
                .put("stderr", "")
        }
        return JSONObject()
            .put("ok", true)
            .put("command", command)
            .put("osType", "android")
            .put("supported", false)
            .put("skipped", true)
            .put("reason", "Shell execution is not supported on Android app nodes")
            .put("exitCode", JSONObject.NULL)
            .put("signal", JSONObject.NULL)
            .put("timedOut", false)
            .put("stdout", "")
            .put("stderr", "")
    }

    /**
     * Handles foundation echo.
     * @param params SQL parameters.
     */
    private fun foundationEcho(params: Any?): JSONObject {
        val payload = params as? JSONObject ?: JSONObject()
        val body = payload.optJSONObject("payload")
        if (body != null && body.optString("kind") == "json") {
            return JSONObject()
                .put("ok", true)
                .put("kind", "json")
                .put("name", body.optString("name"))
                .put("json", body.opt("json"))
        }
        val args = payload.optJSONArray("args") ?: JSONArray()
        val text = buildString {
            for (index in 0 until args.length()) {
                if (index > 0) append(" ")
                append(args.opt(index)?.toString() ?: "")
            }
        }
        return JSONObject()
            .put("ok", true)
            .put("args", args)
            .put("named", payload.optJSONObject("named") ?: JSONObject())
            .put("text", text)
    }

    /**
     * Handles foundation sleep.
     * @param params SQL parameters.
     */
    private fun foundationSleep(params: Any?): JSONObject {
        val ms = (params as? JSONObject)?.optLong("ms", 0) ?: 0
        if (ms > 0) {
            Thread.sleep(ms)
        }
        return JSONObject().put("sleptMs", ms)
    }

    /**
     * Handles execute routed.
     * @param ctx Execution context.
     * @param request Request.
     */
    private fun executeRouted(ctx: RpcCtxValue, request: JSONObject): JSONObject {
        val local = requireLocalNode()
        val state = loadRouteState()
        val effectiveDst = ExecTargetValue.fromJson(request.optJSONObject("dst"))
            ?: if (state.proxyMode.enabled &&
                !state.proxyMode.defaultDstNodeId.isNullOrBlank()
            ) {
                ExecTargetValue("node", state.proxyMode.defaultDstNodeId!!)
            } else {
                null
            }
        val timeoutMs = request.optLong("timeoutMs", 5000).toInt()
        val originNodeId = ctx.originNodeId ?: ctx.srcNodeId ?: local.nodeId
        val path = request.optJSONArray("path") ?: JSONArray()
        val hopCount = request.optInt("hopCount", 0)
        val method = request.optString("method")

        if (method.isBlank() || method == "cord.foundation.exec") {
            throw IllegalArgumentException("invalid routed exec method")
        }

        if (effectiveDst == null ||
            (effectiveDst.kind == "node" && effectiveDst.value == local.nodeId) ||
            (
                effectiveDst.kind == "addr" &&
                    (local.listenAddrs + local.addrs).contains(effectiveDst.value)
                )
        ) {
            return JSONObject()
                .put("result", toJsonValue(invokeHandler(method, ctx, request.opt("params"))))
                .put(
                    "route",
                    JSONObject()
                        .put("contactedNodeId", local.nodeId)
                        .put("executedNodeId", local.nodeId)
                        .put("mode", "local")
                        .put("nextHopNodeId", local.nodeId)
                        .put("path", JSONArray().put(local.nodeId))
                        .put("hops", path)
                )
        }

        if (effectiveDst.kind == "addr") {
            val outbound =
                callDetailed(
                    ExecTargetValue("addr", effectiveDst.value),
                    method,
                    request.opt("params"),
                    timeoutMs,
                    ctx.auth,
                    originNodeId
                )
            val hops = JSONArray(path.toString()).put(
                JSONObject().put("from", local.nodeId).put("to", outbound.peer.nodeId).put(
                    "kind",
                    if (outbound.via ==
                        "reverse"
                    ) {
                        "reverse"
                    } else {
                        "direct"
                    }
                )
            )
            return JSONObject()
                .put("result", toJsonValue(outbound.result))
                .put(
                    "route",
                    JSONObject()
                        .put("contactedNodeId", local.nodeId)
                        .put("executedNodeId", outbound.peer.nodeId)
                        .put("mode", "direct")
                        .put("nextHopNodeId", outbound.peer.nodeId)
                        .put("path", hopPath(hops))
                        .put("hops", hops)
                )
        }

        val dstNodeId = effectiveDst.value
        val route = state.routes[dstNodeId]
        val learnedPeer = state.peers[dstNodeId]
        val proxyNodeId =
            route?.proxyNodeId
                ?: if (learnedPeer != null &&
                    !learnedPeer.suggested
                ) {
                    learnedPeer.viaNodeId
                } else {
                    null
                }
        val denyOutToDst = state.deny[dstNodeId]?.out == true

        if (hopCount > 0 && !proxyNodeId.isNullOrBlank()) {
            throw IllegalStateException("invalid route: proxy hop exceeds 1")
        }

        if (hopCount == 0 && !proxyNodeId.isNullOrBlank()) {
            if (state.deny[proxyNodeId]?.out == true) {
                throw IllegalStateException(
                    "cannot reach proxy $proxyNodeId (route denied or unreachable)"
                )
            }
            val forwardRequest = JSONObject(request.toString())
                .put("dst", JSONObject().put("kind", "node").put("value", dstNodeId))
                .put("hopCount", 1)
                .put(
                    "path",
                    JSONArray(
                        path.toString()
                    ).put(
                        JSONObject().put(
                            "from",
                            local.nodeId
                        ).put("to", proxyNodeId).put("kind", "direct")
                    )
                )
            val forwarded =
                callDetailed(
                    ExecTargetValue("node", proxyNodeId),
                    "cord.foundation.exec",
                    forwardRequest,
                    timeoutMs,
                    ctx.auth,
                    originNodeId
                )
            val forwardedResult = forwarded.result as JSONObject
            val routeObject = forwardedResult.optJSONObject("route") ?: JSONObject()
            val hops = routeObject.optJSONArray("hops") ?: JSONArray()
            val lastHop = hops.optJSONObject(hops.length() - 1)

            mergePeer(dstNodeId) { peer ->
                peer.nodeId = dstNodeId
                peer.viaNodeId = proxyNodeId
                peer.viaDetail =
                    if (lastHop?.optString("kind") == "reverse") "reverse" else "direct"
                peer.lastOutboundMs = nowMs()
                peer.lastSeenMs = nowMs()
                peer.suggested = false
                if (!peer.connected) {
                    peer.expiresAtMs = nowMs() + OBSERVATION_TTL_MS
                }
            }

            return JSONObject()
                .put("result", forwardedResult.opt("result"))
                .put(
                    "route",
                    JSONObject()
                        .put("contactedNodeId", local.nodeId)
                        .put("executedNodeId", routeObject.optString("executedNodeId"))
                        .put("mode", "proxy")
                        .put("nextHopNodeId", proxyNodeId)
                        .put("path", routeObject.optJSONArray("path"))
                        .put("hops", hops)
                )
        }

        val reverseAvailable = reverseIncoming[dstNodeId]?.isActive() == true
        if (denyOutToDst && !reverseAvailable) {
            if (hopCount > 0) {
                throw IllegalStateException(
                    "cannot reach destination $dstNodeId from proxy " +
                        "${local.nodeId} (route denied or unreachable)"
                )
            }
            throw IllegalStateException("no route to $dstNodeId (direct denied, no proxy route)")
        }

        val outbound =
            callDetailed(
                ExecTargetValue("node", dstNodeId),
                method,
                request.opt("params"),
                timeoutMs,
                ctx.auth,
                originNodeId
            )
        val hops = JSONArray(path.toString()).put(
            JSONObject().put("from", local.nodeId).put("to", outbound.peer.nodeId).put(
                "kind",
                if (outbound.via ==
                    "reverse"
                ) {
                    "reverse"
                } else {
                    "direct"
                }
            )
        )
        return JSONObject()
            .put("result", toJsonValue(outbound.result))
            .put(
                "route",
                JSONObject()
                    .put("contactedNodeId", local.nodeId)
                    .put("executedNodeId", outbound.peer.nodeId)
                    .put("mode", if (hopCount > 0) "proxy" else "direct")
                    .put("nextHopNodeId", outbound.peer.nodeId)
                    .put("path", hopPath(hops))
                    .put("hops", hops)
            )
    }

    /**
     * Handles route op.
     * @param payload Payload value.
     */
    private fun routeOp(payload: JSONObject): JSONObject = when (payload.optString("op")) {
        "print" -> getRouteTable().toJson()
        "add" -> {
            setRoute(
                payload.optString("targetNodeId"),
                payload.optString("proxyNodeId").ifBlank {
                    null
                }
            )
            JSONObject().put("ok", true)
        }
        "del" -> {
            deleteRoute(payload.optString("targetNodeId"))
            JSONObject().put("ok", true)
        }
        "deny" -> {
            setRouteDeny(payload.optString("targetNodeId"), payload.optString("direction", "both"))
            JSONObject().put("ok", true)
        }
        else -> throw IllegalArgumentException("Unknown route op ${payload.optString("op")}")
    }

    /**
     * Handles proxy op.
     * @param payload Payload value.
     */
    private fun proxyOp(payload: JSONObject): JSONObject {
        setProxyMode(
            payload.optBoolean("enabled", false),
            payload.optString("defaultDstNodeId").ifBlank {
                null
            }
        )
        return JSONObject()
            .put("ok", true)
            .put("proxyMode", getRouteTable().toJson().optJSONObject("proxyMode"))
    }

    /**
     * Connects to a peer.
     * @param target Target selector.
     * @param ttlMs TTL ms.
     * @param persist Persist.
     */
    private fun connect(target: ExecTargetValue, ttlMs: Long?, persist: Boolean): JSONObject {
        val resolved = resolveDirectAddr(target)
        val openResponse = callHttpDetailed(
            resolved.addr,
            "cord.foundation.reverse.open",
            JSONObject().put("ttlMs", ttlMs ?: JSONObject.NULL),
            5_000,
            internalAuth(),
            requireLocalNode().nodeId
        )
        val result = openResponse.result as JSONObject
        mergePeer(openResponse.peer.nodeId) { peer ->
            applyNodeInfo(peer, openResponse.peer)
            peer.directAddr = resolved.addr
            peer.connected = true
            peer.suggested = false
            peer.expiresAtMs = if (ttlMs != null && ttlMs > 0) nowMs() + ttlMs else null
            peer.lastInboundMs = nowMs()
            peer.lastOutboundMs = nowMs()
            peer.lastSeenMs = nowMs()
        }
        persistConnectIntent(openResponse.peer, target, resolved.addr, ttlMs, persist)

        reverseOutgoing.remove(openResponse.peer.nodeId)?.stop = true
        val connection = ReverseOutgoingConnection(
            remoteNodeId = openResponse.peer.nodeId,
            remoteAddr = resolved.addr,
            sessionId = result.optString("sessionId"),
            expiresAtMs = if (ttlMs != null && ttlMs > 0) nowMs() + ttlMs else null
        )
        reverseOutgoing[openResponse.peer.nodeId] = connection
        executor.execute { runReverseClient(connection) }

        return JSONObject()
            .put("ok", true)
            .put("peer", openResponse.peer.toJson())
            .put("ttlMs", if (ttlMs != null && ttlMs > 0) ttlMs else JSONObject.NULL)
            .put("persist", persist)
    }

    /**
     * Disconnects a peer or route.
     * @param targetNodeId Target node id.
     */
    private fun disconnect(targetNodeId: String): JSONObject {
        if (targetNodeId.isBlank()) {
            throw IllegalArgumentException("disconnect requires a targetNodeId")
        }
        reverseOutgoing.remove(targetNodeId)?.let { outgoing ->
            outgoing.stop = true
            try {
                callHttpDetailed(
                    outgoing.remoteAddr,
                    "cord.foundation.reverse.close",
                    JSONObject().put("sessionId", outgoing.sessionId),
                    2_000,
                    internalAuth(),
                    requireLocalNode().nodeId
                )
            } catch (_: Throwable) {
            }
        }

        reverseIncoming.remove(targetNodeId)?.close("closed by local")
        mergePeer(targetNodeId) { peer ->
            peer.connected = false
            if (peer.expiresAtMs == null) {
                peer.expiresAtMs = nowMs() + OBSERVATION_TTL_MS
            }
        }
        removeConnectIntent(targetNodeId)
        return JSONObject().put("ok", true).put("nodeId", targetNodeId)
    }

    /**
     * Handles restore persistent connections.
     */
    private fun restorePersistentConnections(): JSONObject {
        val now = nowMs()
        val intents = loadConnectIntents().filter { it.expiresAtMs == null || it.expiresAtMs > now }
        val restored = JSONArray()
        val failed = JSONArray()
        saveConnectIntents(intents)
        for (intent in intents) {
            try {
                val remaining = intent.expiresAtMs?.let { (it - now).coerceAtLeast(1) }
                connect(intent.target, remaining, persist = true)
                restored.put(intent.label())
            } catch (error: Throwable) {
                failed.put(
                    JSONObject().put("target", intent.label()).put(
                        "error",
                        error.message ?: error.toString()
                    )
                )
            }
        }
        return JSONObject()
            .put("ok", true)
            .put("attempted", JSONArray(intents.map { it.label() }))
            .put("restored", restored)
            .put("failed", failed)
    }

    /**
     * Learns the value.
     * @param target Target selector.
     */
    private fun learn(target: ExecTargetValue): JSONObject {
        val remote =
            callDetailed(
                target,
                "cord.foundation.peer.list",
                JSONObject(),
                5_000,
                internalAuth(),
                requireLocalNode().nodeId
            )
        val entries = remote.result as JSONArray
        val learned = JSONArray()
        val skipped = JSONArray()
        for (index in 0 until entries.length()) {
            val peer = entries.optJSONObject(index) ?: continue
            val peerNodeId = peer.optString("nodeId")
            if (peerNodeId.isBlank() || peerNodeId == requireLocalNode().nodeId ||
                peerNodeId == remote.peer.nodeId
            ) {
                skipped.put(peerNodeId)
                continue
            }
            val current = loadRouteState().peers[peerNodeId]
            if (current?.connected == true ||
                (
                    current != null && !current.suggested &&
                        (!current.directAddr.isNullOrBlank() || !current.viaNodeId.isNullOrBlank())
                    )
            ) {
                skipped.put(peerNodeId)
                continue
            }
            mergePeer(peerNodeId) { localPeer ->
                localPeer.nodeEpoch = peer.optString("nodeEpoch").ifBlank { null }
                localPeer.addrs = jsonArrayToStrings(peer.optJSONArray("addrs"))
                localPeer.propsJson = peer.opt("props")?.let { valueToJsonString(it) }
                localPeer.viaNodeId = remote.peer.nodeId
                localPeer.viaDetail =
                    if (peer.optString("viaKind") == "reverse") "reverse" else "direct"
                localPeer.suggested = true
                localPeer.connected = false
                localPeer.expiresAtMs = nowMs() + OBSERVATION_TTL_MS
                localPeer.lastSeenMs = nowMs()
            }
            learned.put(peerNodeId)
        }
        return JSONObject().put("ok", true).put("learned", learned).put("skipped", skipped)
    }

    /**
     * Updates route.
     * @param targetNodeId Target node id.
     * @param proxyNodeId Proxy node id.
     */
    private fun setRoute(targetNodeId: String, proxyNodeId: String?) {
        require(targetNodeId.isNotBlank()) { "route target must be a peer node" }
        require(targetNodeId != requireLocalNode().nodeId) { "route target must be a peer node" }
        if (!proxyNodeId.isNullOrBlank()) {
            require(proxyNodeId != requireLocalNode().nodeId && proxyNodeId != targetNodeId) {
                "invalid route: proxy must be a different peer"
            }
        }
        updateRouteState { state ->
            state.routes[targetNodeId] = RouteDef(proxyNodeId)
        }
    }

    /**
     * Removes route.
     * @param targetNodeId Target node id.
     */
    private fun deleteRoute(targetNodeId: String) {
        updateRouteState { state ->
            state.routes.remove(targetNodeId)
        }
    }

    /**
     * Updates route deny.
     * @param targetNodeId Target node id.
     * @param direction Direction.
     */
    private fun setRouteDeny(targetNodeId: String, direction: String) {
        require(targetNodeId.isNotBlank()) { "deny target must be a peer node" }
        updateRouteState { state ->
            val current = state.deny[targetNodeId] ?: DenyDef()
            if (direction == "in" || direction == "both") current.`in` = true
            if (direction == "out" || direction == "both") current.out = true
            state.deny[targetNodeId] = current
        }
    }

    /**
     * Updates proxy mode.
     * @param enabled Enabled.
     * @param defaultDstNodeId Default dst node id.
     */
    private fun setProxyMode(enabled: Boolean, defaultDstNodeId: String?) {
        if (!defaultDstNodeId.isNullOrBlank()) {
            require(defaultDstNodeId != requireLocalNode().nodeId) {
                "proxy default destination must be a different node"
            }
        }
        updateRouteState { state ->
            state.proxyMode =
                ProxyMode(
                    enabled = enabled,
                    defaultDstNodeId = if (enabled) defaultDstNodeId else null
                )
        }
    }

    /**
     * Handles handle reverse open.
     * @param ctx Execution context.
     * @param payload Payload value.
     */
    private fun handleReverseOpen(ctx: RpcCtxValue, payload: JSONObject): JSONObject {
        val peer =
            ctx.srcNodeInfo ?: throw IllegalArgumentException("reverse.open requires srcNodeInfo")
        val ttlMs = payload.optLong("ttlMs", 0)
        val expiresAtMs = if (ttlMs > 0) nowMs() + ttlMs else null
        val session = ReverseIncomingSession(
            sessionId = "reverse_${UUID.randomUUID().toString().replace("-", "")}",
            peer = peer,
            expiresAtMs = expiresAtMs,
            lastSeenMs = nowMs()
        )
        reverseIncoming[peer.nodeId] = session
        mergePeer(peer.nodeId) { record ->
            applyNodeInfo(record, peer)
            record.connected = true
            record.expiresAtMs = expiresAtMs
            record.suggested = false
            record.lastInboundMs = nowMs()
            record.lastOutboundMs = nowMs()
            record.lastSeenMs = nowMs()
        }
        return JSONObject().put("ok", true).put("sessionId", session.sessionId)
    }

    /**
     * Handles handle reverse poll.
     * @param ctx Execution context.
     * @param payload Payload value.
     */
    private fun handleReversePoll(ctx: RpcCtxValue, payload: JSONObject): JSONObject {
        val peerNodeId =
            ctx.srcNodeId ?: throw IllegalArgumentException("reverse.poll requires srcNodeId")
        val session =
            reverseIncoming[peerNodeId] ?: throw IllegalStateException("invalid reverse session")
        if (session.sessionId != payload.optString("sessionId")) {
            throw IllegalStateException("invalid reverse session")
        }
        val waitMs = payload.optLong("waitMs", 15_000).coerceIn(0, 15_000)
        val deadline = nowMs() + waitMs
        while (true) {
            session.lastSeenMs = nowMs()
            session.queue.poll()?.let { request ->
                return JSONObject().put("kind", "request").put("request", request)
            }
            if (session.stop || (session.expiresAtMs != null && nowMs() > session.expiresAtMs!!)) {
                return JSONObject().put("kind", "noop")
            }
            if (nowMs() >= deadline) {
                return JSONObject().put("kind", "noop")
            }
            Thread.sleep(100)
        }
    }

    /**
     * Handles handle reverse reply.
     * @param ctx Execution context.
     * @param payload Payload value.
     */
    private fun handleReverseReply(ctx: RpcCtxValue, payload: JSONObject): JSONObject {
        val peerNodeId =
            ctx.srcNodeId ?: throw IllegalArgumentException("reverse.reply requires srcNodeId")
        val session =
            reverseIncoming[peerNodeId] ?: throw IllegalStateException("invalid reverse session")
        if (session.sessionId != payload.optString("sessionId")) {
            throw IllegalStateException("invalid reverse session")
        }
        val requestId = payload.optString("requestId")
        val pending =
            session.pending.remove(requestId)
                ?: throw IllegalStateException("unknown reverse request $requestId")
        if (payload.optBoolean("ok", false)) {
            pending.complete(payload.opt("result"))
        } else {
            pending.completeExceptionally(
                IllegalStateException(payload.optString("error", "reverse request failed"))
            )
        }
        session.lastSeenMs = nowMs()
        return JSONObject().put("ok", true)
    }

    /**
     * Handles handle reverse close.
     * @param ctx Execution context.
     * @param payload Payload value.
     */
    private fun handleReverseClose(ctx: RpcCtxValue, payload: JSONObject): JSONObject {
        val peerNodeId =
            ctx.srcNodeId ?: throw IllegalArgumentException("reverse.close requires srcNodeId")
        val session = reverseIncoming[peerNodeId]
        if (session != null && session.sessionId == payload.optString("sessionId")) {
            session.close("closed by remote")
            reverseIncoming.remove(peerNodeId)
        }
        return JSONObject().put("ok", true)
    }

    /**
     * Runs reverse client.
     * @param connection Connection.
     */
    private fun runReverseClient(connection: ReverseOutgoingConnection) {
        while (!connection.stop) {
            if (connection.expiresAtMs != null && nowMs() > connection.expiresAtMs!!) {
                connection.stop = true
                break
            }
            try {
                val poll = callHttpDetailed(
                    connection.remoteAddr,
                    "cord.foundation.reverse.poll",
                    JSONObject().put("sessionId", connection.sessionId).put("waitMs", 15_000),
                    20_000,
                    internalAuth(),
                    requireLocalNode().nodeId
                )
                val pollResult = poll.result as JSONObject
                if (pollResult.optString("kind") != "request") {
                    continue
                }
                val request = pollResult.optJSONObject("request") ?: continue
                val requestId = request.optString("requestId")
                val ctx = RpcCtxValue(
                    auth = request.optJSONObject("auth"),
                    srcNodeId = request.optString("srcNodeId").ifBlank { null },
                    srcNodeInfo = request.optJSONObject("srcNodeInfo")?.let {
                        NodeInfoValue.fromJson(it)
                    },
                    originNodeId = request.optString("originNodeId").ifBlank { null },
                    traceId = request.optString("traceId").ifBlank { null }
                )
                try {
                    val result = dispatch(request.optString("method"), ctx, request.opt("params"))
                    callHttpDetailed(
                        connection.remoteAddr,
                        "cord.foundation.reverse.reply",
                        JSONObject()
                            .put("sessionId", connection.sessionId)
                            .put("requestId", requestId)
                            .put("ok", true)
                            .put("result", toJsonValue(result)),
                        10_000,
                        internalAuth(),
                        requireLocalNode().nodeId
                    )
                } catch (error: Throwable) {
                    callHttpDetailed(
                        connection.remoteAddr,
                        "cord.foundation.reverse.reply",
                        JSONObject()
                            .put("sessionId", connection.sessionId)
                            .put("requestId", requestId)
                            .put("ok", false)
                            .put("error", error.message ?: error.toString()),
                        10_000,
                        internalAuth(),
                        requireLocalNode().nodeId
                    )
                }
            } catch (_: Throwable) {
                Thread.sleep(1_000)
            }
        }
        reverseOutgoing.remove(connection.remoteNodeId)
        mergePeer(connection.remoteNodeId) { peer ->
            peer.connected = false
            if (peer.expiresAtMs == null) {
                peer.expiresAtMs = nowMs() + OBSERVATION_TTL_MS
            }
        }
    }

    /**
     * Handles call reverse.
     * @param session Session.
     * @param method Method.
     * @param params SQL parameters.
     * @param timeoutMs Timeout ms.
     * @param auth Authentication payload.
     * @param originNodeId Origin node id.
     */
    private fun callReverse(
        session: ReverseIncomingSession,
        method: String,
        params: Any?,
        timeoutMs: Int,
        auth: JSONObject?,
        originNodeId: String
    ): RpcCallResult {
        val requestId = "req_${UUID.randomUUID().toString().replace("-", "")}"
        val request = JSONObject()
            .put("requestId", requestId)
            .put("method", method)
            .put("params", toJsonValue(params))
            .put("auth", auth ?: internalAuth())
            .put("traceId", "android-${System.currentTimeMillis()}")
            .put("srcNodeId", requireLocalNode().nodeId)
            .put("srcNodeInfo", requireLocalNode().toJson())
            .put("originNodeId", originNodeId)
        val future = CompletableFuture<Any?>()
        session.pending[requestId] = future
        session.queue.add(request)
        val result = future.get(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
        learnOutbound(
            session.peer,
            addr = null,
            viaNodeId = null,
            viaDetail = "reverse",
            connected = true
        )
        return RpcCallResult(result = result, peer = session.peer, via = "reverse")
    }

    /**
     * Handles call detailed.
     * @param target Target selector.
     * @param method Method.
     * @param params SQL parameters.
     * @param timeoutMs Timeout ms.
     * @param auth Authentication payload.
     * @param originNodeId Origin node id.
     */
    private fun callDetailed(
        target: ExecTargetValue,
        method: String,
        params: Any?,
        timeoutMs: Int,
        auth: JSONObject?,
        originNodeId: String
    ): RpcCallResult {
        val local = requireLocalNode()
        if (target.kind == "node") {
            if (target.value == local.nodeId) {
                val ctx =
                    RpcCtxValue(
                        auth = auth,
                        srcNodeId = local.nodeId,
                        srcNodeInfo = local,
                        originNodeId = originNodeId
                    )
                val result = invokeHandler(method, ctx, params)
                learnOutbound(
                    local,
                    addr = local.addrs.firstOrNull(),
                    viaNodeId = null,
                    viaDetail = "direct",
                    connected = false
                )
                return RpcCallResult(result = result, peer = local, via = "local")
            }
            reverseIncoming[target.value]?.takeIf { it.isActive() }?.let { session ->
                return callReverse(session, method, params, timeoutMs, auth, originNodeId)
            }
            val resolved = resolveDirectAddr(target)
            val remote =
                callHttpDetailed(resolved.addr, method, params, timeoutMs, auth, originNodeId)
            learnOutbound(remote.peer, resolved.addr, null, "direct", false)
            return RpcCallResult(result = remote.result, peer = remote.peer, via = "direct")
        }

        if ((local.listenAddrs + local.addrs).contains(target.value)) {
            val ctx =
                RpcCtxValue(
                    auth = auth,
                    srcNodeId = local.nodeId,
                    srcNodeInfo = local,
                    originNodeId = originNodeId
                )
            val result = invokeHandler(method, ctx, params)
            return RpcCallResult(result = result, peer = local, via = "local")
        }
        val remote = callHttpDetailed(target.value, method, params, timeoutMs, auth, originNodeId)
        learnOutbound(remote.peer, target.value, null, "direct", false)
        return RpcCallResult(result = remote.result, peer = remote.peer, via = "direct")
    }

    /**
     * Handles call HTTP detailed.
     * @param addr Network address.
     * @param method Method.
     * @param params SQL parameters.
     * @param timeoutMs Timeout ms.
     * @param auth Authentication payload.
     * @param originNodeId Origin node id.
     */
    private fun callHttpDetailed(
        addr: String,
        method: String,
        params: Any?,
        timeoutMs: Int,
        auth: JSONObject?,
        originNodeId: String
    ): RpcCallResult {
        val local = requireLocalNode()
        val url = URL("http://$addr/rpc")
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = timeoutMs
        connection.readTimeout = timeoutMs
        connection.doOutput = true
        connection.setRequestProperty("content-type", "application/json")
        val request = JSONObject()
            .put("method", method)
            .put("params", toJsonValue(params))
            .put("auth", auth ?: internalAuth())
            .put("traceId", "android-${System.currentTimeMillis()}")
            .put("srcNodeId", local.nodeId)
            .put("srcNodeInfo", local.toJson())
            .put("originNodeId", originNodeId)
        try {
            connection.outputStream.bufferedWriter().use { it.write(request.toString()) }
            val status = connection.responseCode
            val body = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()
                ?.use { it.readText() }
                .orEmpty()
            val response = if (body.isBlank()) {
                JSONObject()
            } else {
                JSONTokener(
                    body
                ).nextValue() as JSONObject
            }
            if (status !in 200..299 || !response.optBoolean("ok", false)) {
                val message =
                    response.optJSONObject("error")?.optString("message")?.ifBlank { null }
                        ?: "$method failed against $addr"
                throw IllegalStateException(message)
            }
            val peer = response.optJSONObject("node")?.let { NodeInfoValue.fromJson(it) }
                ?: throw IllegalStateException(
                    "$method failed against $addr: missing remote node metadata"
                )
            return RpcCallResult(result = response.opt("result"), peer = peer, via = "direct")
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Resolves direct address.
     * @param target Target selector.
     */
    private fun resolveDirectAddr(target: ExecTargetValue): ResolvedTarget {
        if (target.kind == "addr") {
            return ResolvedTarget(target.value, null)
        }
        val state = loadRouteState()
        val peer = state.peers[target.value]
        if (!peer?.directAddr.isNullOrBlank()) {
            return ResolvedTarget(peer!!.directAddr!!, target.value)
        }
        if (!peer?.addrs.isNullOrEmpty()) {
            return ResolvedTarget(peer!!.addrs.first(), target.value)
        }
        throw IllegalStateException("Target ${target.value} is not available")
    }

    /**
     * Lists peer summaries.
     */
    private fun listPeerSummaries(): JSONArray {
        val state = loadRouteState()
        val entries = buildPeerEntries(state)
        val out = JSONArray()
        for (entry in entries) {
            val peer = state.peers[entry.nodeId]
            out.put(
                JSONObject()
                    .put("nodeId", entry.nodeId)
                    .put("nodeEpoch", peer?.nodeEpoch)
                    .put(
                        "addrs",
                        if (peer?.addrs?.isNotEmpty() ==
                            true
                        ) {
                            JSONArray(peer.addrs)
                        } else {
                            JSONObject.NULL
                        }
                    )
                    .put(
                        "props",
                        peer?.propsJson?.let { JSONTokener(it).nextValue() } ?: JSONObject.NULL
                    )
                    .put(
                        "viaKind",
                        when {
                            reverseIncoming.containsKey(entry.nodeId) -> "reverse"
                            !peer?.viaNodeId.isNullOrBlank() -> "proxy"
                            !peer?.directAddr.isNullOrBlank() ||
                                !peer?.addrs.isNullOrEmpty() -> "direct"
                            else -> "unknown"
                        }
                    )
                    .put(
                        "viaValue",
                        peer?.viaNodeId ?: peer?.directAddr ?: peer?.addrs?.firstOrNull()
                    )
                    .put("viaDetail", peer?.viaDetail ?: JSONObject.NULL)
                    .put("ways", entry.ways)
                    .put("ttlRemainingMs", entry.ttlRemainingMs ?: JSONObject.NULL)
                    .put("state", entry.state)
            )
        }
        return out
    }

    /**
     * Returns peer table.
     */
    private fun getPeerTable(): PeerTableValue =
        PeerTableValue(requireLocalNode().nodeId, buildPeerEntries(loadRouteState()))

    /**
     * Returns route table.
     */
    private fun getRouteTable(): RouteTableValue {
        val state = loadRouteState()
        val knownNodeIds = linkedSetOf<String>()
        knownNodeIds.addAll(state.routes.keys)
        state.routes.values.mapNotNullTo(knownNodeIds) { it.proxyNodeId }
        knownNodeIds.addAll(state.deny.keys)
        buildPeerEntries(state).forEach { knownNodeIds += it.nodeId }
        state.proxyMode.defaultDstNodeId?.let { knownNodeIds += it }

        val entries = knownNodeIds
            .filter { it != requireLocalNode().nodeId }
            .sorted()
            .map { nodeId ->
                val peer = buildPeerEntry(nodeId, state)
                val explicitRoute = state.routes[nodeId]
                val deny = state.deny[nodeId] ?: DenyDef()
                val path = renderPathForNode(
                    nodeId,
                    state,
                    explicitRoute?.proxyNodeId ?: state.peers[nodeId]?.viaNodeId,
                    peer?.viaDetail
                )
                RouteEntryValue(
                    nodeId = nodeId,
                    via = explicitRoute?.proxyNodeId ?: peer?.via ?: "-",
                    path = path,
                    ways = peer?.ways ?: "-",
                    state = if (!explicitRoute?.proxyNodeId.isNullOrBlank()) {
                        "configured"
                    } else {
                        peer?.state
                            ?: "configured"
                    },
                    denyIn = deny.`in`,
                    denyOut = deny.out,
                    ttlRemainingMs = peer?.ttlRemainingMs
                )
            }
        return RouteTableValue(
            requireLocalNode().nodeId,
            state.proxyMode,
            OBSERVATION_TTL_MS,
            entries
        )
    }

    /**
     * Learns inbound.
     * @param srcNodeId Src node id.
     * @param srcNodeInfo Src node info.
     */
    private fun learnInbound(srcNodeId: String?, srcNodeInfo: NodeInfoValue?) {
        if (srcNodeId.isNullOrBlank() || srcNodeId == requireLocalNode().nodeId ||
            srcNodeId.startsWith("coord-cli-")
        ) {
            return
        }
        mergePeer(srcNodeId) { peer ->
            if (srcNodeInfo != null) {
                applyNodeInfo(peer, srcNodeInfo)
                if (peer.directAddr.isNullOrBlank() && srcNodeInfo.addrs.isNotEmpty()) {
                    peer.directAddr = srcNodeInfo.addrs.first()
                }
            }
            peer.lastInboundMs = nowMs()
            peer.lastSeenMs = nowMs()
            peer.suggested = false
            if (!peer.connected) {
                peer.expiresAtMs = nowMs() + OBSERVATION_TTL_MS
            }
        }
    }

    /**
     * Learns outbound.
     * @param info Table metadata.
     * @param addr Network address.
     * @param viaNodeId Via node id.
     * @param viaDetail Via detail.
     * @param connected Connected.
     */
    private fun learnOutbound(
        info: NodeInfoValue,
        addr: String?,
        viaNodeId: String?,
        viaDetail: String?,
        connected: Boolean
    ) {
        if (info.nodeId.isBlank() || info.nodeId == requireLocalNode().nodeId ||
            info.nodeId.startsWith("coord-cli-")
        ) {
            return
        }
        mergePeer(info.nodeId) { peer ->
            applyNodeInfo(peer, info)
            if (!addr.isNullOrBlank()) {
                peer.directAddr = addr
            }
            if (!viaNodeId.isNullOrBlank()) {
                peer.viaNodeId = viaNodeId
                peer.viaDetail = viaDetail ?: "direct"
            }
            peer.connected = connected
            peer.lastOutboundMs = nowMs()
            peer.lastSeenMs = nowMs()
            peer.suggested = false
            if (!connected) {
                peer.expiresAtMs = nowMs() + OBSERVATION_TTL_MS
            }
        }
    }

    /**
     * Learns proxy origin.
     * @param originNodeId Origin node id.
     * @param viaNodeId Via node id.
     */
    private fun learnProxyOrigin(originNodeId: String?, viaNodeId: String?) {
        if (originNodeId.isNullOrBlank() || viaNodeId.isNullOrBlank()) return
        if (originNodeId == requireLocalNode().nodeId || originNodeId == viaNodeId ||
            originNodeId.startsWith("coord-cli-")
        ) {
            return
        }
        mergePeer(originNodeId) { peer ->
            peer.nodeId = originNodeId
            peer.viaNodeId = viaNodeId
            peer.viaDetail = "direct"
            peer.lastInboundMs = nowMs()
            peer.lastSeenMs = nowMs()
            peer.suggested = false
            if (!peer.connected) {
                peer.expiresAtMs = nowMs() + OBSERVATION_TTL_MS
            }
        }
    }

    /**
     * Handles enforce inbound route policy.
     * @param srcNodeId Src node id.
     */
    private fun enforceInboundRoutePolicy(srcNodeId: String?) {
        if (srcNodeId.isNullOrBlank() || srcNodeId == requireLocalNode().nodeId ||
            srcNodeId.startsWith("coord-cli-")
        ) {
            return
        }
        val state = loadRouteState()
        if (state.deny[srcNodeId]?.`in` == true) {
            throw IllegalStateException("route denied: in from $srcNodeId")
        }
    }

    /**
     * Builds peer entries.
     * @param state Internal state record.
     */
    private fun buildPeerEntries(state: RouteState): List<PeerEntryValue> {
        val now = nowMs()
        val entries = mutableListOf<PeerEntryValue>()
        for ((nodeId, peer) in state.peers) {
            val connected = peer.connected && isLiveConnectedPeer(nodeId)
            val outbound =
                connected ||
                    (
                        peer.lastOutboundMs != null &&
                            peer.lastOutboundMs!! + OBSERVATION_TTL_MS > now
                        )
            val inbound =
                connected ||
                    (peer.lastInboundMs != null && peer.lastInboundMs!! + OBSERVATION_TTL_MS > now)
            val suggested = peer.suggested && !connected && !outbound && !inbound
            if (!connected && !outbound && !inbound && !suggested) {
                continue
            }
            entries += PeerEntryValue(
                nodeId = nodeId,
                via = viaLabelForPeer(nodeId, peer),
                ways = when {
                    outbound && inbound -> "both"
                    outbound -> "out"
                    inbound -> "in"
                    else -> "-"
                },
                ttlRemainingMs = if (connected) {
                    null
                } else {
                    peer.expiresAtMs?.let {
                        (it - now).coerceAtLeast(0)
                    }
                },
                state = when {
                    connected -> "connected"
                    suggested -> "suggested"
                    else -> "learned"
                },
                nodeEpoch = peer.nodeEpoch,
                addrs = peer.addrs
            )
        }
        return entries.sortedBy { it.nodeId }
    }

    /**
     * Builds peer entry.
     * @param nodeId Node identifier.
     * @param state Internal state record.
     */
    private fun buildPeerEntry(nodeId: String, state: RouteState): PeerEntryValue? =
        buildPeerEntries(state).firstOrNull { it.nodeId == nodeId }

    /**
     * Handles via label for peer.
     * @param nodeId Node identifier.
     * @param peer Peer.
     */
    private fun viaLabelForPeer(nodeId: String, peer: PeerState): String {
        if (peer.connected && reverseIncoming.containsKey(nodeId)) {
            return "reverse"
        }
        if (!peer.viaNodeId.isNullOrBlank()) {
            return "via ${peer.viaNodeId}"
        }
        if (!peer.directAddr.isNullOrBlank()) {
            return peer.directAddr!!
        }
        if (peer.addrs.isNotEmpty()) {
            return peer.addrs.first()
        }
        if (peer.connected && reverseOutgoing.containsKey(nodeId)) {
            return reverseOutgoing[nodeId]?.remoteAddr ?: "-"
        }
        return "-"
    }

    /**
     * Handles render path for node.
     * @param nodeId Node identifier.
     * @param state Internal state record.
     * @param explicitProxyNodeId Explicit proxy node id.
     * @param viaDetail Via detail.
     */
    private fun renderPathForNode(
        nodeId: String,
        state: RouteState,
        explicitProxyNodeId: String?,
        viaDetail: String?
    ): String {
        val localNodeId = requireLocalNode().nodeId
        if (reverseIncoming.containsKey(nodeId)) {
            return "$localNodeId -< $nodeId"
        }
        val proxyNodeId = explicitProxyNodeId ?: state.peers[nodeId]?.viaNodeId
        if (!proxyNodeId.isNullOrBlank()) {
            val finalHop =
                if (viaDetail == "reverse") {
                    " -< $nodeId"
                } else {
                    " -> $nodeId"
                }
            return "$localNodeId -> $proxyNodeId$finalHop"
        }
        return "$localNodeId -> $nodeId"
    }

    /**
     * Merges peer.
     * @param nodeId Node identifier.
     * @param mutator Mutator.
     */
    private fun mergePeer(nodeId: String, mutator: (PeerState) -> Unit) {
        updateRouteState { state ->
            val peer = state.peers[nodeId] ?: PeerState(nodeId = nodeId)
            mutator(peer)
            state.peers[nodeId] = peer
        }
    }

    /**
     * Applies node info.
     * @param peer Peer.
     * @param info Table metadata.
     */
    private fun applyNodeInfo(peer: PeerState, info: NodeInfoValue) {
        peer.nodeId = info.nodeId
        peer.nodeEpoch = info.nodeEpoch
        peer.addrs = info.addrs.toMutableList()
        peer.propsJson = info.propsJson
    }

    /**
     * Handles load route state.
     */
    private fun loadRouteState(): RouteState {
        val local = localNode
        val key = "coord.routeState.${local?.nodeId ?: "default"}"
        val raw = db.getJsonState(key) ?: return RouteState()
        return try {
            RouteState.fromJson(JSONObject(raw))
        } catch (_: Throwable) {
            RouteState()
        }
    }

    /**
     * Handles persist route state.
     * @param state Internal state record.
     */
    private fun persistRouteState(state: RouteState) {
        val local = localNode
        val key = "coord.routeState.${local?.nodeId ?: "default"}"
        db.putJsonState(key, state.toJson().toString())
    }

    /**
     * Handles load local node configuration.
     */
    private fun loadLocalNodeConfig(): LocalNodeConfigValue? {
        val raw = db.getJsonState(LOCAL_NODE_CONFIG_KEY) ?: return null
        return try {
            LocalNodeConfigValue.fromJson(JSONObject(raw))
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * Handles save local node configuration.
     * @param config Configuration.
     */
    private fun saveLocalNodeConfig(config: LocalNodeConfigValue) {
        db.putJsonState(LOCAL_NODE_CONFIG_KEY, config.toJson().toString())
    }

    /**
     * Connects intents key.
     */
    private fun connectIntentsKey(): String {
        val nodeId = localNode?.nodeId ?: loadLocalNodeConfig()?.nodeId ?: "default"
        return "coord.connectIntents.$nodeId"
    }

    /**
     * Handles load connect intents.
     */
    private fun loadConnectIntents(): List<LocalConnectIntent> {
        val raw = db.getJsonState(connectIntentsKey()) ?: return emptyList()
        return try {
            val array = JSONTokener(raw).nextValue() as? JSONArray ?: return emptyList()
            buildList {
                for (index in 0 until array.length()) {
                    val value = array.optJSONObject(index) ?: continue
                    LocalConnectIntent.fromJson(value)?.let(::add)
                }
            }
        } catch (_: Throwable) {
            emptyList()
        }
    }

    /**
     * Handles save connect intents.
     * @param intents Intents.
     */
    private fun saveConnectIntents(intents: List<LocalConnectIntent>) {
        val array = JSONArray()
        for (intent in intents.sortedBy { it.id }) {
            array.put(intent.toJson())
        }
        db.putJsonState(connectIntentsKey(), array.toString())
    }

    /**
     * Handles persist connect intent.
     * @param peer Peer.
     * @param target Target selector.
     * @param directAddr Direct address.
     * @param ttlMs TTL ms.
     * @param persist Persist.
     */
    private fun persistConnectIntent(
        peer: NodeInfoValue,
        target: ExecTargetValue,
        directAddr: String,
        ttlMs: Long?,
        persist: Boolean
    ) {
        val next = loadConnectIntents()
            .filter { it.id != peer.nodeId && it.peerNodeId != peer.nodeId }
            .toMutableList()
        if (persist) {
            next += LocalConnectIntent(
                id = peer.nodeId,
                target = target,
                peerNodeId = peer.nodeId,
                directAddr = directAddr,
                expiresAtMs = if (ttlMs != null && ttlMs > 0) nowMs() + ttlMs else null,
                createdAtMs = nowMs()
            )
        }
        saveConnectIntents(next.filter { it.expiresAtMs == null || it.expiresAtMs > nowMs() })
    }

    /**
     * Removes connect intent.
     * @param targetNodeId Target node id.
     */
    private fun removeConnectIntent(targetNodeId: String) {
        saveConnectIntents(
            loadConnectIntents().filter {
                it.id != targetNodeId &&
                    it.peerNodeId != targetNodeId
            }
        )
    }

    /**
     * Handles update route state.
     * @param mutator Mutator.
     */
    private fun updateRouteState(mutator: (RouteState) -> Unit) {
        synchronized(lock) {
            val state = loadRouteState()
            mutator(state)
            persistRouteState(state)
        }
    }

    /**
     * Returns whether live connected peer.
     * @param nodeId Node identifier.
     */
    private fun isLiveConnectedPeer(nodeId: String): Boolean =
        reverseIncoming[nodeId]?.isActive() == true ||
            reverseOutgoing[nodeId]?.let { !it.stop } == true

    /**
     * Handles internal auth.
     */
    private fun internalAuth(): JSONObject = JSONObject()
        .put("userId", "node:${requireLocalNode().nodeId}")
        .put("groups", JSONArray().put("grp:internal"))
        .put("internal", true)

    /**
     * Stops internal.
     */
    private fun stopInternal() {
        reverseOutgoing.values.forEach { it.stop = true }
        reverseOutgoing.clear()
        reverseIncoming.values.forEach { it.close("node stopped") }
        reverseIncoming.clear()
        server?.stop()
        server = null
        localNode = null
    }

    /**
     * Handles require local node.
     */
    private fun requireLocalNode(): LocalNode =
        localNode ?: throw IllegalStateException("Local Android coord node is not running")

    /**
     * Reads JSON body.
     * @param session Session.
     */
    private fun readJsonBody(session: NanoHTTPD.IHTTPSession): JSONObject {
        val files = HashMap<String, String>()
        session.parseBody(files)
        val body = files["postData"].orEmpty().trim()
        return if (body.isBlank()) JSONObject() else JSONTokener(body).nextValue() as JSONObject
    }

    /**
     * Handles JSON response.
     * @param status Status.
     * @param payload Payload value.
     */
    private fun jsonResponse(
        status: NanoHTTPD.Response.Status,
        payload: JSONObject
    ): NanoHTTPD.Response {
        val response = NanoHTTPD.newFixedLengthResponse(status, "application/json", "${payload}\n")
        response.addHeader("content-type", "application/json")
        return response
    }

    /**
     * Handles discover advertise addresses.
     * @param port TCP port.
     */
    private fun discoverAdvertiseAddrs(port: Int): List<String> {
        val hosts = mutableListOf<String>()
        val interfaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
        for (network in interfaces) {
            val name = network.name ?: continue
            if (!network.isUp || network.isLoopback || name.startsWith("docker") ||
                name.startsWith("rmnet_data")
            ) {
                continue
            }
            for (address in network.inetAddresses.toList()) {
                val host = address.hostAddress ?: continue
                if (address.isLoopbackAddress || host.contains(":") ||
                    host.startsWith("169.254.")
                ) {
                    continue
                }
                hosts += "$host:$port"
            }
        }
        if (hosts.isEmpty()) {
            hosts += "127.0.0.1:$port"
        }
        return hosts.distinct()
    }

    companion object {
        private const val OBSERVATION_TTL_MS = 300_000L
        private const val LOCAL_NODE_CONFIG_KEY = "coord.local.nodeConfig"

        @Volatile
        private var instance: EmbeddedCoordNode? = null

        /**
         * Returns the value.
         * @param db Database name.
         */
        fun get(db: TesterDatabaseHelper): EmbeddedCoordNode = instance ?: synchronized(this) {
            instance ?: EmbeddedCoordNode(db).also { instance = it }
        }

        /**
         * Handles now ms.
         */
        private fun nowMs(): Long = System.currentTimeMillis()

        /**
         * Handles error JSON.
         * @param message Message.
         */
        private fun errorJson(message: String): JSONObject = JSONObject().put("message", message)

        /**
         * Handles to JSON value.
         * @param value Value to process.
         */
        private fun toJsonValue(value: Any?): Any = when (value) {
            null -> JSONObject.NULL
            is JSONObject, is JSONArray, is String, is Number, is Boolean -> value
            is LocalNode -> value.toJson()
            is NodeInfoValue -> value.toJson()
            is PeerTableValue -> value.toJson()
            is RouteTableValue -> value.toJson()
            is PeerEntryValue -> value.toJson()
            is RouteEntryValue -> value.toJson()
            is Collection<*> -> JSONArray().apply { value.forEach { put(toJsonValue(it)) } }
            else -> value.toString()
        }

        /**
         * Handles hop path.
         * @param hops Hops.
         */
        private fun hopPath(hops: JSONArray): JSONArray {
            if (hops.length() == 0) {
                return JSONArray()
            }
            val parts = JSONArray()
            val first = hops.optJSONObject(0)
            parts.put(first?.optString("from"))
            for (index in 0 until hops.length()) {
                parts.put(hops.optJSONObject(index)?.optString("to"))
            }
            return parts
        }

        /**
         * Handles value to JSON string.
         * @param value Value to process.
         */
        private fun valueToJsonString(value: Any?): String = when (value) {
            null, JSONObject.NULL -> "null"
            is JSONObject -> value.toString()
            is JSONArray -> value.toString()
            is String -> JSONObject.quote(value)
            is Number, is Boolean -> value.toString()
            else -> value.toString()
        }

        /**
         * Formats JSON.
         * @param raw Raw.
         */
        private fun prettyJson(raw: String): String {
            val trimmed = raw.trim()
            if (trimmed.isBlank()) {
                return "{}"
            }
            return when (val parsed = JSONTokener(trimmed).nextValue()) {
                is JSONObject -> parsed.toString()
                is JSONArray -> parsed.toString()
                else -> JSONObject().put("value", parsed).opt("value").toString()
            }
        }

        /**
         * Handles JSON array to strings.
         * @param array Array.
         */
        private fun jsonArrayToStrings(array: JSONArray?): MutableList<String> {
            val values = mutableListOf<String>()
            if (array == null) return values
            for (index in 0 until array.length()) {
                val value = array.optString(index)
                if (value.isNotBlank()) values += value
            }
            return values
        }
    }
}

private class CoordHttpServer(port: Int, private val node: EmbeddedCoordNode) : NanoHTTPD(port) {
    override fun serve(session: IHTTPSession): Response = node.handleHttp(session)
}

private class LocalNode(
    override val nodeId: String,
    override val nodeEpoch: String,
    val port: Int,
    val listenAddrs: List<String>,
    override val addrs: List<String>,
    val props: JSONObject
) : NodeInfoValue(nodeId, nodeEpoch, addrs, props.toString()) {
    override fun toJson(): JSONObject = super.toJson()
}

private open class NodeInfoValue(
    open val nodeId: String,
    open val nodeEpoch: String,
    open val addrs: List<String> = emptyList(),
    open val propsJson: String? = null
) {
    open fun toJson(): JSONObject = JSONObject()
        .put("nodeId", nodeId)
        .put("nodeEpoch", nodeEpoch)
        .put("addrs", if (addrs.isNotEmpty()) JSONArray(addrs) else JSONObject.NULL)
        .put("props", propsJson?.let { JSONTokener(it).nextValue() } ?: JSONObject.NULL)

    companion object {
        /**
         * Deserializes the value from JSON.
         * @param value Value to process.
         */
        fun fromJson(value: JSONObject): NodeInfoValue = NodeInfoValue(
            nodeId = value.optString("nodeId"),
            nodeEpoch = value.optString("nodeEpoch"),
            addrs = mutableListOf<String>().apply {
                val items = value.optJSONArray("addrs")
                if (items != null) {
                    for (index in 0 until items.length()) {
                        val addr = items.optString(index)
                        if (addr.isNotBlank()) add(addr)
                    }
                }
            },
            propsJson = value.opt("props")?.takeUnless {
                it == JSONObject.NULL
            }?.let { it.toString() }
        )
    }
}

private data class RpcCtxValue(
    val auth: JSONObject? = null,
    val srcNodeId: String? = null,
    val srcNodeInfo: NodeInfoValue? = null,
    val originNodeId: String? = null,
    val traceId: String? = null
)

private data class LocalNodeConfigValue(val nodeId: String, val port: Int) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject().put("nodeId", nodeId).put("port", port)

    companion object {
        /**
         * Deserializes the value from JSON.
         * @param value Value to process.
         */
        fun fromJson(value: JSONObject): LocalNodeConfigValue? {
            val nodeId = value.optString("nodeId")
            val port = value.optInt("port", 0)
            if (nodeId.isBlank() || port <= 0) {
                return null
            }
            return LocalNodeConfigValue(nodeId = nodeId, port = port)
        }
    }
}

private data class ExecTargetValue(val kind: String, val value: String) {
    companion object {
        /**
         * Deserializes the value from JSON.
         * @param value Value to process.
         */
        fun fromJson(value: JSONObject?): ExecTargetValue? {
            if (value == null) return null
            val kind = value.optString("kind")
            val raw = value.optString("value")
            if (kind.isBlank() || raw.isBlank()) return null
            return ExecTargetValue(kind, raw)
        }
    }
}

private data class LocalConnectIntent(
    val id: String,
    val target: ExecTargetValue,
    val peerNodeId: String?,
    val directAddr: String?,
    val expiresAtMs: Long?,
    val createdAtMs: Long
) {
    /**
     * Returns the user-facing label.
     */
    fun label(): String = peerNodeId ?: "${target.kind}:${target.value}"

    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("target", JSONObject().put("kind", target.kind).put("value", target.value))
        .put("peerNodeId", peerNodeId ?: JSONObject.NULL)
        .put("directAddr", directAddr ?: JSONObject.NULL)
        .put("expiresAtMs", expiresAtMs ?: JSONObject.NULL)
        .put("createdAtMs", createdAtMs)

    companion object {
        /**
         * Deserializes the value from JSON.
         * @param value Value to process.
         */
        fun fromJson(value: JSONObject): LocalConnectIntent? {
            val id = value.optString("id")
            val target = ExecTargetValue.fromJson(value.optJSONObject("target")) ?: return null
            val normalizedId = id.ifBlank {
                value.optString("peerNodeId").ifBlank { "${target.kind}:${target.value}" }
            }
            return LocalConnectIntent(
                id = normalizedId,
                target = target,
                peerNodeId = value.optString("peerNodeId").ifBlank { null },
                directAddr = value.optString("directAddr").ifBlank { null },
                expiresAtMs = value.optLong("expiresAtMs").takeIf {
                    value.has("expiresAtMs") &&
                        value.opt("expiresAtMs") != JSONObject.NULL
                },
                createdAtMs = value.optLong("createdAtMs", System.currentTimeMillis())
            )
        }
    }
}

private data class ResolvedTarget(val addr: String, val nodeId: String?)

private data class RpcCallResult(val result: Any?, val peer: NodeInfoValue, val via: String)

private data class RouteState(
    val routes: MutableMap<String, RouteDef> = mutableMapOf(),
    val deny: MutableMap<String, DenyDef> = mutableMapOf(),
    var proxyMode: ProxyMode = ProxyMode(),
    val peers: MutableMap<String, PeerState> = mutableMapOf()
) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject()
        .put("version", 2)
        .put(
            "routes",
            JSONObject().apply {
                for ((key, value) in routes) put(key, value.toJson())
            }
        )
        .put(
            "deny",
            JSONObject().apply {
                for ((key, value) in deny) put(key, value.toJson())
            }
        )
        .put("proxyMode", proxyMode.toJson())
        .put(
            "peers",
            JSONObject().apply {
                for ((key, value) in peers) put(key, value.toJson())
            }
        )

    companion object {
        /**
         * Deserializes the value from JSON.
         * @param value Value to process.
         */
        fun fromJson(value: JSONObject): RouteState {
            val routes = mutableMapOf<String, RouteDef>()
            val deny = mutableMapOf<String, DenyDef>()
            val peers = mutableMapOf<String, PeerState>()
            val routeJson = value.optJSONObject("routes") ?: JSONObject()
            val denyJson = value.optJSONObject("deny") ?: JSONObject()
            val peerJson = value.optJSONObject("peers") ?: JSONObject()
            for (key in routeJson.keys()) {
                routes[key] =
                    RouteDef.fromJson(routeJson.optJSONObject(key) ?: JSONObject())
            }
            for (key in denyJson.keys()) {
                deny[key] =
                    DenyDef.fromJson(denyJson.optJSONObject(key) ?: JSONObject())
            }
            for (key in peerJson.keys()) {
                peers[key] =
                    PeerState.fromJson(key, peerJson.optJSONObject(key) ?: JSONObject())
            }
            return RouteState(
                routes = routes,
                deny = deny,
                proxyMode = ProxyMode.fromJson(value.optJSONObject("proxyMode") ?: JSONObject()),
                peers = peers
            )
        }
    }
}

private data class RouteDef(val proxyNodeId: String? = null) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject().put("proxyNodeId", proxyNodeId ?: JSONObject.NULL)
    companion object {
        /**
         * Deserializes the value from JSON.
         * @param value Value to process.
         */
        fun fromJson(value: JSONObject): RouteDef =
            RouteDef(value.optString("proxyNodeId").ifBlank { null })
    }
}

private data class DenyDef(var `in`: Boolean = false, var out: Boolean = false) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject().put("in", `in`).put("out", out)
    companion object {
        /**
         * Deserializes the value from JSON.
         * @param value Value to process.
         */
        fun fromJson(value: JSONObject): DenyDef =
            DenyDef(value.optBoolean("in", false), value.optBoolean("out", false))
    }
}

private data class ProxyMode(var enabled: Boolean = false, var defaultDstNodeId: String? = null) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject().put("enabled", enabled).put(
        "defaultDstNodeId",
        defaultDstNodeId ?: JSONObject.NULL
    )
    companion object {
        /**
         * Deserializes the value from JSON.
         * @param value Value to process.
         */
        fun fromJson(value: JSONObject): ProxyMode = ProxyMode(
            value.optBoolean("enabled", false),
            value.optString("defaultDstNodeId").ifBlank {
                null
            }
        )
    }
}

private data class PeerState(
    var nodeId: String,
    var nodeEpoch: String? = null,
    var addrs: MutableList<String> = mutableListOf(),
    var propsJson: String? = null,
    var directAddr: String? = null,
    var viaNodeId: String? = null,
    var viaDetail: String? = null,
    var suggested: Boolean = false,
    var connected: Boolean = false,
    var expiresAtMs: Long? = null,
    var lastSeenMs: Long? = null,
    var lastInboundMs: Long? = null,
    var lastOutboundMs: Long? = null
) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject()
        .put("nodeEpoch", nodeEpoch ?: JSONObject.NULL)
        .put("addrs", if (addrs.isNotEmpty()) JSONArray(addrs) else JSONObject.NULL)
        .put("props", propsJson?.let { JSONTokener(it).nextValue() } ?: JSONObject.NULL)
        .put("directAddr", directAddr ?: JSONObject.NULL)
        .put("viaNodeId", viaNodeId ?: JSONObject.NULL)
        .put("viaDetail", viaDetail ?: JSONObject.NULL)
        .put("suggested", suggested)
        .put("connected", connected)
        .put("expiresAtMs", expiresAtMs ?: JSONObject.NULL)
        .put("lastSeenMs", lastSeenMs ?: JSONObject.NULL)
        .put("lastInboundMs", lastInboundMs ?: JSONObject.NULL)
        .put("lastOutboundMs", lastOutboundMs ?: JSONObject.NULL)

    companion object {
        /**
         * Deserializes the value from JSON.
         * @param nodeId Node identifier.
         * @param value Value to process.
         */
        fun fromJson(nodeId: String, value: JSONObject): PeerState = PeerState(
            nodeId = nodeId,
            nodeEpoch = value.optString("nodeEpoch").ifBlank { null },
            addrs = mutableListOf<String>().apply {
                val array = value.optJSONArray("addrs")
                if (array != null) {
                    for (index in 0 until array.length()) {
                        val addr = array.optString(index)
                        if (addr.isNotBlank()) add(addr)
                    }
                }
            },
            propsJson = value.opt("props")?.takeUnless { it == JSONObject.NULL }?.toString(),
            directAddr = value.optString("directAddr").ifBlank { null },
            viaNodeId = value.optString("viaNodeId").ifBlank { null },
            viaDetail = value.optString("viaDetail").ifBlank { null },
            suggested = value.optBoolean("suggested", false),
            connected = value.optBoolean("connected", false),
            expiresAtMs = value.optLong("expiresAtMs").takeIf {
                value.has("expiresAtMs") &&
                    value.opt("expiresAtMs") != JSONObject.NULL
            },
            lastSeenMs = value.optLong("lastSeenMs").takeIf {
                value.has("lastSeenMs") &&
                    value.opt("lastSeenMs") != JSONObject.NULL
            },
            lastInboundMs = value.optLong("lastInboundMs").takeIf {
                value.has("lastInboundMs") &&
                    value.opt("lastInboundMs") != JSONObject.NULL
            },
            lastOutboundMs = value.optLong("lastOutboundMs").takeIf {
                value.has("lastOutboundMs") &&
                    value.opt("lastOutboundMs") != JSONObject.NULL
            }
        )
    }
}

private data class PeerEntryValue(
    val nodeId: String,
    val via: String,
    val ways: String,
    val ttlRemainingMs: Long?,
    val state: String,
    val nodeEpoch: String? = null,
    val addrs: List<String> = emptyList(),
    val viaDetail: String? = null
) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject()
        .put("nodeId", nodeId)
        .put("via", via)
        .put("ways", ways)
        .put("ttlRemainingMs", ttlRemainingMs ?: JSONObject.NULL)
        .put("state", state)
        .put("nodeEpoch", nodeEpoch ?: JSONObject.NULL)
        .put("addrs", if (addrs.isNotEmpty()) JSONArray(addrs) else JSONObject.NULL)
}

private data class PeerTableValue(val nodeId: String, val entries: List<PeerEntryValue>) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject().put("nodeId", nodeId).put(
        "entries",
        JSONArray().apply {
            entries.forEach { put(it.toJson()) }
        }
    )
}

private data class RouteEntryValue(
    val nodeId: String,
    val via: String,
    val path: String,
    val ways: String,
    val state: String,
    val denyIn: Boolean,
    val denyOut: Boolean,
    val ttlRemainingMs: Long?
) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject()
        .put("nodeId", nodeId)
        .put("via", via)
        .put("path", path)
        .put("ways", ways)
        .put("state", state)
        .put("denyIn", denyIn)
        .put("denyOut", denyOut)
        .put("ttlRemainingMs", ttlRemainingMs ?: JSONObject.NULL)
}

private data class RouteTableValue(
    val nodeId: String,
    val proxyMode: ProxyMode,
    val observationTtlMs: Long,
    val entries: List<RouteEntryValue>
) {
    /**
     * Serializes the value to JSON.
     */
    fun toJson(): JSONObject = JSONObject()
        .put("nodeId", nodeId)
        .put("proxyMode", proxyMode.toJson())
        .put("observationTtlMs", observationTtlMs)
        .put("entries", JSONArray().apply { entries.forEach { put(it.toJson()) } })
}

private data class ReverseOutgoingConnection(
    val remoteNodeId: String,
    val remoteAddr: String,
    val sessionId: String,
    val expiresAtMs: Long?,
    @Volatile var stop: Boolean = false
)

private class ReverseIncomingSession(
    val sessionId: String,
    val peer: NodeInfoValue,
    val expiresAtMs: Long?,
    @Volatile var lastSeenMs: Long
) {
    val queue = java.util.concurrent.ConcurrentLinkedQueue<JSONObject>()
    val pending = ConcurrentHashMap<String, CompletableFuture<Any?>>()

    @Volatile var stop: Boolean = false

    /**
     * Closes the resource and releases any associated handles.
     * @param _reason Reason.
     */
    fun close(_reason: String) {
        stop = true
        pending.values.forEach {
            it.completeExceptionally(IllegalStateException("reverse session closed"))
        }
        pending.clear()
    }

    /**
     * Returns whether active.
     */
    fun isActive(): Boolean =
        !stop && (expiresAtMs == null || System.currentTimeMillis() <= expiresAtMs)
}
