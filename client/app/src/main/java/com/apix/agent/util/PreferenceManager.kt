package com.apix.agent.util

import android.content.Context
import android.content.SharedPreferences

class PreferenceManager(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("apix_prefs", Context.MODE_PRIVATE)

    // ── Server connection ─────────────────────────────────────
    var serverHost: String?
        get() = prefs.getString(KEY_SERVER_HOST, null)
        set(v) = prefs.edit().putString(KEY_SERVER_HOST, v).apply()

    var serverPort: Int
        get() = prefs.getInt(KEY_SERVER_PORT, 3000)
        set(v) = prefs.edit().putInt(KEY_SERVER_PORT, v).apply()

    var serverName: String?
        get() = prefs.getString(KEY_SERVER_NAME, null)
        set(v) = prefs.edit().putString(KEY_SERVER_NAME, v).apply()

    var deviceToken: String?
        get() = prefs.getString(KEY_DEVICE_TOKEN, null)
        set(v) = prefs.edit().putString(KEY_DEVICE_TOKEN, v).apply()

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(v) = prefs.edit().putString(KEY_DEVICE_ID, v).apply()

    /** One-time pairing token from QR scan — cleared after use */
    var pairingToken: String?
        get() = prefs.getString(KEY_PAIRING_TOKEN, null)
        set(v) = prefs.edit().putString(KEY_PAIRING_TOKEN, v).apply()

    /** All WebSocket URLs from QR scan payload (JSON array string) */
    var qrWsUrls: String?
        get() = prefs.getString(KEY_QR_WS_URLS, null)
        set(v) = prefs.edit().putString(KEY_QR_WS_URLS, v).apply()

    // ── Boot / persistence ────────────────────────────────────
    var startOnBoot: Boolean
        get() = prefs.getBoolean(KEY_START_ON_BOOT, false)
        set(v) = prefs.edit().putBoolean(KEY_START_ON_BOOT, v).apply()

    // ── MMS ───────────────────────────────────────────────────
    var mmsEnabled: Boolean
        get() = prefs.getBoolean(KEY_MMS_ENABLED, true)
        set(v) = prefs.edit().putBoolean(KEY_MMS_ENABLED, v).apply()

    // ── Advanced ──────────────────────────────────────────────
    var wsPingIntervalSeconds: Int
        get() = prefs.getInt(KEY_WS_PING, 30)
        set(v) = prefs.edit().putInt(KEY_WS_PING, v).apply()

    var heartbeatIntervalSeconds: Int
        get() = prefs.getInt(KEY_HEARTBEAT, 30)
        set(v) = prefs.edit().putInt(KEY_HEARTBEAT, v).apply()

    /** Show connection debug lines in Log → Debug tab */
    var debugUiLogs: Boolean
        get() = prefs.getBoolean(KEY_DEBUG_UI_LOGS, false)
        set(v) = prefs.edit().putBoolean(KEY_DEBUG_UI_LOGS, v).apply()

    // ── Stats ─────────────────────────────────────────────────
    var sentToday: Int
        get() = prefs.getInt(KEY_SENT_TODAY, 0)
        set(v) = prefs.edit().putInt(KEY_SENT_TODAY, v).apply()

    var receivedToday: Int
        get() = prefs.getInt(KEY_RECEIVED_TODAY, 0)
        set(v) = prefs.edit().putInt(KEY_RECEIVED_TODAY, v).apply()

    var failedToday: Int
        get() = prefs.getInt(KEY_FAILED_TODAY, 0)
        set(v) = prefs.edit().putInt(KEY_FAILED_TODAY, v).apply()

    var lastStatReset: Long
        get() = prefs.getLong(KEY_LAST_STAT_RESET, 0L)
        set(v) = prefs.edit().putLong(KEY_LAST_STAT_RESET, v).apply()

    fun isServerConfigured(): Boolean = !serverHost.isNullOrBlank()

    fun clearServer() {
        prefs.edit()
            .remove(KEY_SERVER_HOST)
            .remove(KEY_SERVER_PORT)
            .remove(KEY_SERVER_NAME)
            .remove(KEY_DEVICE_TOKEN)
            .remove(KEY_DEVICE_ID)
            .apply()
    }

    fun resetDailyStats() {
        prefs.edit()
            .putInt(KEY_SENT_TODAY, 0)
            .putInt(KEY_RECEIVED_TODAY, 0)
            .putInt(KEY_FAILED_TODAY, 0)
            .putLong(KEY_LAST_STAT_RESET, System.currentTimeMillis())
            .apply()
    }

    companion object {
        private const val KEY_SERVER_HOST      = "server_host"
        private const val KEY_SERVER_PORT      = "server_port"
        private const val KEY_SERVER_NAME      = "server_name"
        private const val KEY_DEVICE_TOKEN     = "device_token"
        private const val KEY_DEVICE_ID        = "device_id"
        private const val KEY_START_ON_BOOT    = "start_on_boot"
        private const val KEY_MMS_ENABLED      = "mms_enabled"
        private const val KEY_WS_PING          = "ws_ping_interval"
        private const val KEY_HEARTBEAT        = "heartbeat_interval"
        private const val KEY_SENT_TODAY       = "sent_today"
        private const val KEY_RECEIVED_TODAY   = "received_today"
        private const val KEY_FAILED_TODAY     = "failed_today"
        private const val KEY_LAST_STAT_RESET  = "last_stat_reset"
        private const val KEY_PAIRING_TOKEN    = "pairing_token"
        private const val KEY_QR_WS_URLS       = "qr_ws_urls"
        private const val KEY_DEBUG_UI_LOGS    = "debug_ui_logs"
    }
}
