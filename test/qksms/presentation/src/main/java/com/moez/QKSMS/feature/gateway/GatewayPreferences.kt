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

import android.content.Context
import android.content.SharedPreferences

class GatewayPreferences(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var serverHost: String?
        get() = prefs.getString(KEY_HOST, null)?.takeIf { it.isNotBlank() }
        set(value) { prefs.edit().putString(KEY_HOST, value).apply() }

    var serverPort: Int
        get() = prefs.getInt(KEY_PORT, 3000).coerceIn(1, 65535)
        set(value) { prefs.edit().putInt(KEY_PORT, value).apply() }

    var useTls: Boolean
        get() = prefs.getBoolean(KEY_TLS, false)
        set(value) { prefs.edit().putBoolean(KEY_TLS, value).apply() }

    var deviceToken: String?
        get() = prefs.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }
        set(value) { prefs.edit().putString(KEY_TOKEN, value).commit() }

    var pairingToken: String?
        get() = prefs.getString(KEY_PAIRING, null)?.takeIf { it.isNotBlank() }
        set(value) { prefs.edit().putString(KEY_PAIRING, value).commit() }

    /** When true, [GatewayBootReceiver] starts the relay after BOOT_COMPLETED */
    var startOnBoot: Boolean
        get() = prefs.getBoolean(KEY_START_ON_BOOT, true)
        set(value) { prefs.edit().putBoolean(KEY_START_ON_BOOT, value).apply() }

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) { prefs.edit().putString(KEY_DEVICE_ID, value).commit() }

    /**
     * Last SMS row [_id] from Telephony provider that was forwarded to ApiX (-1 = not bootstrapped).
     */
    var lastSmsContentId: Long
        get() = prefs.getLong(KEY_LAST_SMS_ID, -1L)
        set(value) { prefs.edit().putLong(KEY_LAST_SMS_ID, value).apply() }

    companion object {
        private const val PREFS_NAME = "apix_gateway"
        private const val KEY_HOST = "host"
        private const val KEY_PORT = "port"
        private const val KEY_TLS = "use_tls"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_PAIRING = "pairing_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_LAST_SMS_ID = "last_sms_content_id"
        private const val KEY_START_ON_BOOT = "start_on_boot"
    }
}
