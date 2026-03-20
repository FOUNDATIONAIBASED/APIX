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

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.gson.JsonObject
import com.moez.QKSMS.R
import com.moez.QKSMS.model.Attachment
import com.moez.QKSMS.repository.MessageRepository
import com.moez.QKSMS.util.PhoneNumberUtils
import dagger.android.AndroidInjection
import timber.log.Timber
import java.io.File
import java.io.FileOutputStream
import javax.inject.Inject

/**
 * Relays ApiX WebSocket send commands through QKSMS [MessageRepository] (SMS/MMS pipeline).
 */
class GatewayRelayService : Service() {

    @Inject lateinit var messageRepository: MessageRepository
    @Inject lateinit var phoneNumberUtils: PhoneNumberUtils

    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var gatewayPrefs: GatewayPreferences
    private var wsClient: GatewayWebSocketClient? = null
    private var relayStarted = false
    private var heartbeatRunnable: Runnable? = null
    private var currentStatus = STATUS_OFFLINE

    private var smsInboundObserver: ContentObserver? = null
    private var smsObserverThread: HandlerThread? = null
    private var smsObserverHandler: Handler? = null

    override fun onCreate() {
        AndroidInjection.inject(this)
        super.onCreate()
        gatewayPrefs = GatewayPreferences(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopRelay()
            return START_NOT_STICKY
        }

        val host = gatewayPrefs.serverHost
        if (host.isNullOrBlank()) {
            Timber.w("Gateway: no host configured")
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIF_ID, buildNotification(STATUS_OFFLINE))

        if (!relayStarted) {
            relayStarted = true
            val scheme = if (gatewayPrefs.useTls) "wss" else "ws"
            val port = gatewayPrefs.serverPort
            val wsUrl = "$scheme://$host:$port/ws"
            wsClient = GatewayWebSocketClient(wsUrl).also { client ->
                client.connect(object : GatewayWebSocketClient.Listener {
                    override fun onConnected() {
                        mainHandler.post {
                            updateStatus(STATUS_CONNECTED)
                            registerDevice(client)
                            startHeartbeat(client)
                        }
                    }

                    override fun onMessage(type: String, payload: JsonObject) {
                        mainHandler.post { handleServerMessage(client, type, payload) }
                    }

                    override fun onDisconnected(reason: String) {
                        mainHandler.post {
                            updateStatus(STATUS_RECONNECTING)
                            stopHeartbeat()
                            // Inbound flush retries when we are registered + connected again.
                            smsObserverHandler?.post { flushInboundSms() }
                        }
                    }

                    override fun onError(error: String) {
                        mainHandler.post {
                            Timber.w("Gateway WS: $error")
                            updateStatus(STATUS_RECONNECTING)
                        }
                    }
                })
            }
        }

        return START_STICKY
    }

    private fun registerDevice(client: GatewayWebSocketClient) {
        val sims = GatewaySimUtils.simPayloads(this)
        val battery = GatewaySimUtils.batteryPercent(this)
        val payload = mutableMapOf<String, Any?>(
            "type" to "register",
            "model" to Build.MODEL,
            "androidVersion" to Build.VERSION.RELEASE,
            "sims" to sims,
            "battery" to battery
        )
        gatewayPrefs.deviceToken?.let { payload["token"] = it }
        gatewayPrefs.pairingToken?.let {
            payload["pairingToken"] = it
            gatewayPrefs.pairingToken = null
        }
        client.send(payload)
    }

    private fun handleServerMessage(client: GatewayWebSocketClient, type: String, payload: JsonObject) {
        when (type) {
            "registered" -> {
                payload.get("token")?.asString?.let { gatewayPrefs.deviceToken = it }
                payload.get("deviceId")?.asString?.let { gatewayPrefs.deviceId = it }
                startSmsInboundObserver()
            }
            "approved" -> {
                Timber.i("Gateway: device approved")
                startSmsInboundObserver()
            }
            "send_sms" -> {
                val msgId = payload.get("msgId")?.asString ?: return
                val to = payload.get("to")?.asString ?: return
                val body = payload.get("body")?.asString ?: ""
                val from = payload.get("from")?.asString
                sendSmsThroughQk(client, msgId, to, body, from)
            }
            "send_mms" -> {
                val msgId = payload.get("msgId")?.asString ?: return
                val to = payload.get("to")?.asString ?: return
                val subject = payload.get("subject")?.asString ?: ""
                val media = payload.get("media")?.asString ?: return
                val mediaType = payload.get("mediaType")?.asString
                val from = payload.get("from")?.asString
                sendMmsThroughQk(client, msgId, to, subject, media, mediaType, from)
            }
            "heartbeat_ack" -> { /* no-op */ }
        }
    }

    private fun sendSmsThroughQk(
        client: GatewayWebSocketClient,
        msgId: String,
        to: String,
        body: String,
        from: String?
    ) {
        try {
            val subId = resolveSubId(from)
            messageRepository.sendMessage(subId, 0L, listOf(to), body, emptyList(), 0)
            client.send(mapOf("type" to "sms_sent", "msgId" to msgId))
        } catch (e: Exception) {
            Timber.e(e, "Gateway SMS send failed")
            client.send(
                mapOf(
                    "type" to "sms_failed",
                    "msgId" to msgId,
                    "error" to (e.message ?: "send failed")
                )
            )
        }
    }

    private fun sendMmsThroughQk(
        client: GatewayWebSocketClient,
        msgId: String,
        to: String,
        subject: String,
        mediaBase64: String,
        mediaType: String?,
        from: String?
    ) {
        try {
            val bytes = Base64.decode(mediaBase64, Base64.DEFAULT)
            val ext = extensionForMime(mediaType)
            val file = File(cacheDir, "gateway_mms_${System.currentTimeMillis()}.$ext")
            FileOutputStream(file).use { it.write(bytes) }
            val uri = FileProvider.getUriForFile(
                this,
                "${packageName}.fileprovider",
                file
            )
            val subId = resolveSubId(from)
            val attachments = listOf(Attachment.Image(uri))
            val bodyText = subject
            messageRepository.sendMessage(subId, 0L, listOf(to), bodyText, attachments, 0)
            client.send(mapOf("type" to "sms_sent", "msgId" to msgId))
        } catch (e: Exception) {
            Timber.e(e, "Gateway MMS send failed")
            client.send(
                mapOf(
                    "type" to "sms_failed",
                    "msgId" to msgId,
                    "error" to (e.message ?: "mms failed")
                )
            )
        }
    }

    private fun extensionForMime(mime: String?): String {
        return when (mime) {
            "image/jpeg", "image/jpg" -> "jpg"
            "image/png" -> "png"
            "image/gif" -> "gif"
            "video/3gpp" -> "3gp"
            else -> "dat"
        }
    }

    private fun resolveSubId(from: String?): Int {
        if (from.isNullOrBlank()) {
            return defaultSubscriptionId()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            val sm = getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? SubscriptionManager
            sm?.activeSubscriptionInfoList?.forEach { info ->
                val n = info.number
                if (!n.isNullOrBlank() && phoneNumberUtils.compare(n, from)) {
                    return info.subscriptionId
                }
            }
        }
        return defaultSubscriptionId()
    }

    @Suppress("DEPRECATION")
    private fun defaultSubscriptionId(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            SubscriptionManager.getDefaultSubscriptionId()
        } else {
            -1
        }
    }

    private fun startHeartbeat(client: GatewayWebSocketClient) {
        stopHeartbeat()
        heartbeatRunnable = object : Runnable {
            override fun run() {
                if (client.isConnected()) {
                    val battery = GatewaySimUtils.batteryPercent(this@GatewayRelayService)
                    client.send(
                        mapOf(
                            "type" to "heartbeat",
                            "battery" to battery,
                            "sentToday" to 0,
                            "receivedToday" to 0
                        )
                    )
                }
                mainHandler.postDelayed(this, 30_000L)
            }
        }
        mainHandler.postDelayed(heartbeatRunnable!!, 30_000L)
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    private fun stopRelay() {
        relayStarted = false
        stopHeartbeat()
        unregisterSmsInboundObserver()
        wsClient?.disconnect()
        wsClient = null
        stopForeground(true)
        stopSelf()
    }

    /**
     * Watches Telephony SMS provider for new inbox rows and sends [sms_received] to ApiX
     * (same shape as the standalone agent). Skips historical messages on first bootstrap.
     */
    private fun startSmsInboundObserver() {
        if (smsInboundObserver != null) {
            smsObserverHandler?.post {
                bootstrapSmsCursorIfNeeded()
                flushInboundSms()
            }
            return
        }
        val thread = HandlerThread("GatewaySmsInbound").apply { start() }
        smsObserverThread = thread
        smsObserverHandler = Handler(thread.looper)
        smsInboundObserver = object : ContentObserver(smsObserverHandler!!) {
            override fun onChange(selfChange: Boolean) {
                smsObserverHandler?.post { flushInboundSms() }
            }
        }
        contentResolver.registerContentObserver(
            Telephony.Sms.CONTENT_URI,
            true,
            smsInboundObserver!!
        )
        smsObserverHandler!!.post {
            bootstrapSmsCursorIfNeeded()
            flushInboundSms()
        }
    }

    private fun unregisterSmsInboundObserver() {
        smsInboundObserver?.let {
            try {
                contentResolver.unregisterContentObserver(it)
            } catch (_: Exception) {
            }
        }
        smsInboundObserver = null
        smsObserverThread?.quitSafely()
        smsObserverThread = null
        smsObserverHandler = null
    }

    private fun bootstrapSmsCursorIfNeeded() {
        if (gatewayPrefs.lastSmsContentId >= 0L) return
        val maxId = queryLargestInboxSmsId() ?: 0L
        gatewayPrefs.lastSmsContentId = maxOf(0L, maxId)
        Timber.d("Gateway SMS inbound bootstrapped at content _id=%s", gatewayPrefs.lastSmsContentId)
    }

    private fun queryLargestInboxSmsId(): Long? {
        return try {
            contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(Telephony.Sms._ID),
                "${Telephony.Sms.TYPE} = ?",
                arrayOf(Telephony.Sms.MESSAGE_TYPE_INBOX.toString()),
                "${Telephony.Sms._ID} DESC"
            )?.use { c ->
                if (c.moveToFirst()) c.getLong(0) else null
            }
        } catch (e: SecurityException) {
            Timber.e(e, "Gateway: cannot read SMS inbox (permission?)")
            null
        }
    }

    @SuppressLint("MissingPermission")
    private fun flushInboundSms() {
        val client = wsClient ?: return
        try {
            val last = gatewayPrefs.lastSmsContentId
            val projection = arrayOf(
                Telephony.Sms._ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.DATE
            )
            val selection = "${Telephony.Sms.TYPE} = ? AND ${Telephony.Sms._ID} > ?"
            val args = arrayOf(
                Telephony.Sms.MESSAGE_TYPE_INBOX.toString(),
                last.toString()
            )
            contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                projection,
                selection,
                args,
                "${Telephony.Sms._ID} ASC"
            )?.use { cursor ->
                val idCol = cursor.getColumnIndexOrThrow(Telephony.Sms._ID)
                val addrCol = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val bodyCol = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
                val dateCol = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
                while (cursor.moveToNext()) {
                    if (!client.isConnected()) return
                    val id = cursor.getLong(idCol)
                    val from = cursor.getString(addrCol) ?: continue
                    val body = cursor.getString(bodyCol) ?: ""
                    val timestamp = cursor.getLong(dateCol)
                    val toNum = GatewaySimUtils.primaryOwnNumber(this)
                    client.send(
                        mapOf(
                            "type" to "sms_received",
                            "from" to from,
                            "to" to toNum,
                            "body" to body,
                            "timestamp" to timestamp
                        )
                    )
                    gatewayPrefs.lastSmsContentId = id
                }
            }
        } catch (e: SecurityException) {
            Timber.e(e, "Gateway inbound SMS flush: READ_SMS denied?")
        } catch (e: Exception) {
            Timber.e(e, "Gateway inbound SMS flush failed")
        }
    }

    private fun updateStatus(status: String) {
        currentStatus = status
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(status))
    }

    private fun buildNotification(status: String): android.app.Notification {
        val text = when (status) {
            STATUS_CONNECTED -> getString(R.string.gateway_notif_connected)
            STATUS_RECONNECTING -> getString(R.string.gateway_notif_reconnecting)
            else -> getString(R.string.gateway_notif_offline)
        }
        val open = Intent(this, GatewayActivity::class.java)
        val pendingOpen = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.gateway_notif_title))
            .setContentText(text)
            .setContentIntent(pendingOpen)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.gateway_notif_channel),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.gateway_notif_channel)
                setShowBadge(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        relayStarted = false
        stopHeartbeat()
        unregisterSmsInboundObserver()
        wsClient?.disconnect()
        wsClient = null
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "com.moez.QKSMS.gateway.STOP"

        private const val CHANNEL_ID = "apix_gateway_relay"
        private const val NOTIF_ID = 91001

        private const val STATUS_CONNECTED = "connected"
        private const val STATUS_RECONNECTING = "reconnecting"
        private const val STATUS_OFFLINE = "offline"

        fun start(context: Context) {
            val intent = Intent(context, GatewayRelayService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, GatewayRelayService::class.java).setAction(ACTION_STOP)
            )
        }
    }
}
