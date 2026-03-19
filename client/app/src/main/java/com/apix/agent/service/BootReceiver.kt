package com.apix.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.apix.agent.util.PreferenceManager

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val validActions = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.LOCKED_BOOT_COMPLETED",
            Intent.ACTION_MY_PACKAGE_REPLACED,
        )
        if (intent.action !in validActions) return

        val prefs = PreferenceManager(context)

        if (!prefs.startOnBoot) {
            Log.d("BootReceiver", "Start-on-boot disabled — skipping")
            return
        }

        if (!prefs.isServerConfigured()) {
            Log.d("BootReceiver", "No server configured — skipping auto-start")
            return
        }

        Log.i("BootReceiver", "Boot detected — starting AgentForegroundService")
        val serviceIntent = Intent(context, AgentForegroundService::class.java)
            .putExtra(AgentForegroundService.EXTRA_BOOT_START, true)

        ContextCompat.startForegroundService(context, serviceIntent)
    }
}
