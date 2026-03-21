/*
 * Copyright (C) 2025
 *
 * This file is part of QKSMS (ApiX gateway integration).
 */
package com.moez.QKSMS.feature.gateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts the ApiX WebSocket relay after reboot when the user has enabled it and a server host is saved.
 */
class GatewayBootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        val prefs = GatewayPreferences(context.applicationContext)
        if (prefs.startOnBoot && !prefs.serverHost.isNullOrBlank()) {
            GatewayRelayService.start(context.applicationContext, fromBoot = true)
        }
    }
}
