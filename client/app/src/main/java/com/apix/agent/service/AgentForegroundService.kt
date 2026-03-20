package com.apix.agent.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.telephony.SmsManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.apix.agent.R
import com.apix.agent.model.DeviceInfo
import com.apix.agent.network.WebSocketClient
import com.apix.agent.util.AppLog
import com.apix.agent.util.PreferenceManager
import com.apix.agent.util.SimUtils
import com.google.gson.JsonObject
import java.util.concurrent.atomic.AtomicInteger

class AgentForegroundService : Service() {

    // ── Live stats broadcast (for UI updates) ─────────────────
    companion object {
        const val ACTION_SMS_RECEIVED   = "com.apix.agent.SMS_RECEIVED"
        const val ACTION_STATUS_UPDATE  = "com.apix.agent.STATUS_UPDATE"
        const val EXTRA_FROM            = "from"
        const val EXTRA_BODY            = "body"
        const val EXTRA_TIMESTAMP       = "timestamp"
        const val EXTRA_BOOT_START      = "boot_start"
        const val EXTRA_STATUS          = "status"
        const val EXTRA_SERVER_NAME     = "server_name"
        const val STATUS_CONNECTED      = "connected"
        const val STATUS_RECONNECTING   = "reconnecting"
        const val STATUS_OFFLINE        = "offline"
        private  const val NOTIF_ID     = 1001
        private  const val CHANNEL_ID   = "apix_agent_service"
        private  const val TAG          = "AgentService"
    }

    private lateinit var prefs: PreferenceManager
    private lateinit var wsClient: WebSocketClient
    private val handler = Handler(Looper.getMainLooper())
    private var heartbeatRunnable: Runnable? = null
    private val sentCount     = AtomicInteger(0)
    private val receivedCount = AtomicInteger(0)
    private val failedCount   = AtomicInteger(0)
    private var paused = false
    private var currentStatus = STATUS_OFFLINE

    // Receive SMS from SmsReceiver broadcast
    private val smsRelayReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != ACTION_SMS_RECEIVED) return
            val from      = intent.getStringExtra(EXTRA_FROM)      ?: return
            val body      = intent.getStringExtra(EXTRA_BODY)      ?: ""
            val timestamp = intent.getLongExtra(EXTRA_TIMESTAMP, System.currentTimeMillis())

            receivedCount.incrementAndGet()
            prefs.receivedToday = receivedCount.get()

            if (!paused) {
                wsClient.send(mapOf(
                    "type"      to "sms_received",
                    "from"      to from,
                    "to"        to getOwnNumber(),
                    "body"      to body,
                    "timestamp" to timestamp,
                ))
            }

            broadcastStatusUpdate()
        }
    }

    override fun onCreate() {
        super.onCreate()
        prefs = PreferenceManager(this)
        createNotificationChannel()

        val filter = IntentFilter(ACTION_SMS_RECEIVED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(smsRelayReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(smsRelayReceiver, filter)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification(STATUS_OFFLINE))

        val host = prefs.serverHost ?: run {
            Log.w(TAG, "No server configured — stopping service")
            stopSelf()
            return START_NOT_STICKY
        }
        val port  = prefs.serverPort
        val wsUrl = "ws://$host:$port/ws"

        wsClient = WebSocketClient(wsUrl)
        wsClient.connect(object : WebSocketClient.Listener {

            override fun onConnected() {
                Log.i(TAG, "WS connected to $wsUrl")
                dbg("WS connected")
                updateStatus(STATUS_CONNECTED)
                registerDevice()
                startHeartbeat()
            }

            override fun onMessage(type: String, payload: JsonObject) {
                handleServerMessage(type, payload)
            }

            override fun onDisconnected(reason: String) {
                Log.i(TAG, "WS disconnected: $reason")
                updateStatus(STATUS_RECONNECTING)
                stopHeartbeat()
            }

            override fun onError(error: String) {
                Log.e(TAG, "WS error: $error")
                updateStatus(STATUS_RECONNECTING)
            }
        })

        return START_STICKY
    }

    // ── Device registration ───────────────────────────────────
    private fun registerDevice() {
        val sims = SimUtils.getSimCards(this)
        val battery = SimUtils.getBatteryLevel(this)

        val simsList = sims.map { sim ->
            mapOf(
                "slot"    to sim.slot,
                "number"  to sim.number,
                "carrier" to sim.carrier,
                "signal"  to sim.signalDbm,
            )
        }

        val payload = mutableMapOf<String, Any?>(
            "type"           to "register",
            "model"          to android.os.Build.MODEL,
            "androidVersion" to android.os.Build.VERSION.RELEASE,
            "sims"           to simsList,
            "battery"        to battery,
        )
        prefs.deviceToken?.let { payload["token"] = it }
        // Include one-time QR pairing token on first registration (clears after use)
        prefs.pairingToken?.let {
            payload["pairingToken"] = it
            prefs.pairingToken = null  // consume it
        }
        wsClient.send(payload)
        dbg("sent register (${simsList.size} SIMs)")
    }

    private fun dbg(msg: String) {
        if (prefs.debugUiLogs) AppLog.add(msg)
    }

    // ── Handle messages from server ───────────────────────────
    private fun handleServerMessage(type: String, payload: JsonObject) {
        when (type) {
            "registered" -> {
                val token    = payload.get("token")?.asString
                val deviceId = payload.get("deviceId")?.asString
                val status   = payload.get("status")?.asString ?: "pending"
                if (token != null) prefs.deviceToken = token
                if (deviceId != null) prefs.deviceId = deviceId
                Log.i(TAG, "Registered as $deviceId (status: $status)")
            }

            "approved" -> {
                Log.i(TAG, "Device approved by server admin")
            }

            "send_sms" -> {
                if (paused) return
                val msgId = payload.get("msgId")?.asString ?: return
                val to    = payload.get("to")?.asString    ?: return
                val body  = payload.get("body")?.asString  ?: ""
                sendSms(msgId, to, body)
            }

            "send_mms" -> {
                if (paused) return
                val msgId     = payload.get("msgId")?.asString  ?: return
                val to        = payload.get("to")?.asString     ?: return
                val subject   = payload.get("subject")?.asString
                val media     = payload.get("media")?.asString
                val mediaType = payload.get("mediaType")?.asString
                MmsHandler.sendMms(this, to, subject, media, mediaType, msgId)
            }

            "heartbeat_ack" -> { /* server acknowledged heartbeat */ }
        }
    }

    // ── SMS sending ────────────────────────────────────────────
    @Suppress("DEPRECATION")
    private fun sendSms(msgId: String, to: String, body: String) {
        try {
            val smsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                getSystemService(SmsManager::class.java)
            } else {
                SmsManager.getDefault()
            }

            val sentIntent = PendingIntent.getBroadcast(
                this, msgId.hashCode(),
                Intent("com.apix.agent.SMS_SENT").putExtra("msgId", msgId),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val deliveredIntent = PendingIntent.getBroadcast(
                this, (msgId + "_d").hashCode(),
                Intent("com.apix.agent.SMS_DELIVERED").putExtra("msgId", msgId),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )

            val parts = smsManager.divideMessage(body)
            if (parts.size == 1) {
                smsManager.sendTextMessage(to, null, body, sentIntent, deliveredIntent)
            } else {
                val sentIntents     = ArrayList(List(parts.size) { if (it == 0) sentIntent else null })
                val deliveredIntents = ArrayList(List(parts.size) { if (it == 0) deliveredIntent else null })
                smsManager.sendMultipartTextMessage(to, null, parts, sentIntents, deliveredIntents)
            }

            sentCount.incrementAndGet()
            prefs.sentToday = sentCount.get()
            broadcastStatusUpdate()

            wsClient.send(mapOf("type" to "sms_sent", "msgId" to msgId))
            Log.i(TAG, "SMS sent to $to (id: $msgId)")
        } catch (e: Exception) {
            Log.e(TAG, "SMS send failed", e)
            failedCount.incrementAndGet()
            prefs.failedToday = failedCount.get()
            wsClient.send(mapOf("type" to "sms_failed", "msgId" to msgId, "error" to e.message))
        }
    }

    // ── Heartbeat ─────────────────────────────────────────────
    private fun startHeartbeat() {
        stopHeartbeat()
        val intervalMs = (prefs.heartbeatIntervalSeconds * 1000L).coerceAtLeast(10_000L)
        heartbeatRunnable = object : Runnable {
            override fun run() {
                if (wsClient.isConnected()) {
                    val battery = SimUtils.getBatteryLevel(this@AgentForegroundService)
                    wsClient.send(mapOf(
                        "type"          to "heartbeat",
                        "battery"       to battery,
                        "sentToday"     to sentCount.get(),
                        "receivedToday" to receivedCount.get(),
                    ))
                }
                handler.postDelayed(this, intervalMs)
            }
        }
        handler.postDelayed(heartbeatRunnable!!, intervalMs)
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { handler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    // ── Status & notification ─────────────────────────────────
    private fun updateStatus(status: String) {
        currentStatus = status
        val notifManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notifManager.notify(NOTIF_ID, buildNotification(status))
        broadcastStatusUpdate()
    }

    private fun broadcastStatusUpdate() {
        val intent = Intent(ACTION_STATUS_UPDATE).apply {
            putExtra(EXTRA_STATUS,      currentStatus)
            putExtra(EXTRA_SERVER_NAME, prefs.serverName ?: prefs.serverHost)
            putExtra("sent_today",      sentCount.get())
            putExtra("received_today",  receivedCount.get())
            putExtra("failed_today",    failedCount.get())
        }
        sendBroadcast(intent)
    }

    private fun buildNotification(status: String): Notification {
        val text = when (status) {
            STATUS_CONNECTED    -> getString(R.string.notif_text_connected)
            STATUS_RECONNECTING -> getString(R.string.notif_text_reconnecting)
            else                -> getString(R.string.notif_text_offline)
        }

        val openIntent = Intent().setClassName(this, "com.apix.agent.ui.MainActivity")
        val pendingOpen = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.notif_title))
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
                getString(R.string.notif_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.notif_channel_desc)
                setShowBadge(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    private fun getOwnNumber(): String {
        return SimUtils.getSimCards(this).firstOrNull()?.number ?: "unknown"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        stopHeartbeat()
        try { unregisterReceiver(smsRelayReceiver) } catch (_: Exception) {}
        if (::wsClient.isInitialized) wsClient.disconnect()
        Log.i(TAG, "Service destroyed")
    }
}
