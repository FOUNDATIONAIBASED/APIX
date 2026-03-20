/*
 * Copyright (C) 2025
 *
 * This file is part of QKSMS (ApiX gateway integration).
 *
 * QKSMS is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
package com.moez.QKSMS.feature.gateway

import com.google.gson.Gson
import com.google.gson.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import timber.log.Timber
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal class GatewayWebSocketClient(private val wsUrl: String) {

    interface Listener {
        fun onConnected()
        fun onMessage(type: String, payload: JsonObject)
        fun onDisconnected(reason: String)
        fun onError(error: String)
    }

    private val gson = Gson()
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private var listener: Listener? = null
    private val connected = AtomicBoolean(false)
    private var reconnectAttempts = 0
    private var reconnectJob: Thread? = null
    private var shouldReconnect = true

    fun connect(listener: Listener) {
        this.listener = listener
        shouldReconnect = true
        reconnectAttempts = 0
        doConnect()
    }

    private fun doConnect() {
        Timber.d("Gateway WS connecting to $wsUrl")
        val request = Request.Builder().url(wsUrl).build()
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                connected.set(true)
                reconnectAttempts = 0
                listener?.onConnected()
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val obj = gson.fromJson(text, JsonObject::class.java)
                    val type = obj.get("type")?.asString ?: return
                    listener?.onMessage(type, obj)
                } catch (e: Exception) {
                    Timber.e(e, "Gateway WS parse error")
                }
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                onMessage(ws, bytes.utf8())
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                ws.close(1000, null)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                connected.set(false)
                listener?.onDisconnected(reason)
                if (shouldReconnect) scheduleReconnect()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Timber.e(t, "Gateway WS failure")
                connected.set(false)
                listener?.onError(t.message ?: "Connection failed")
                if (shouldReconnect) scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        reconnectJob?.interrupt()
        reconnectJob = Thread {
            val delay = backoffDelay(reconnectAttempts)
            Timber.d("Gateway WS reconnect in ${delay}ms (attempt ${reconnectAttempts + 1})")
            try {
                Thread.sleep(delay)
            } catch (_: InterruptedException) {
                return@Thread
            }
            reconnectAttempts++
            if (shouldReconnect) doConnect()
        }.also {
            it.isDaemon = true
            it.start()
        }
    }

    private fun backoffDelay(attempt: Int): Long {
        val base = 1000L * (1L shl attempt.coerceAtMost(5))
        return base.coerceAtMost(30_000L)
    }

    fun send(data: Map<String, Any?>) {
        if (!connected.get()) {
            Timber.w("Gateway WS send skipped: not connected")
            return
        }
        try {
            val json = gson.toJson(data)
            webSocket?.send(json)
        } catch (e: Exception) {
            Timber.e(e, "Gateway WS send failed")
        }
    }

    fun disconnect() {
        shouldReconnect = false
        reconnectJob?.interrupt()
        reconnectJob = null
        webSocket?.close(1000, "stop")
        webSocket = null
        connected.set(false)
    }

    fun isConnected(): Boolean = connected.get()
}
