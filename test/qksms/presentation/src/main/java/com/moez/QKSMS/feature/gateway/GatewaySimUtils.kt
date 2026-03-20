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

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat

internal object GatewaySimUtils {

    fun simPayloads(context: Context): List<Map<String, Any?>> {
        val result = mutableListOf<Map<String, Any?>>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE)
                == PackageManager.PERMISSION_GRANTED) {
                val sm = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE)
                    as? SubscriptionManager
                val subs = sm?.activeSubscriptionInfoList
                if (!subs.isNullOrEmpty()) {
                    for (sub in subs) {
                        result.add(
                            mapOf(
                                "slot" to (sub.simSlotIndex + 1),
                                "number" to sub.number?.takeIf { it.isNotBlank() },
                                "carrier" to sub.carrierName?.toString(),
                                "signal" to null
                            )
                        )
                    }
                    return result
                }
            }
        }
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return result
        val number = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_NUMBERS)
            == PackageManager.PERMISSION_GRANTED) {
            tm.line1Number?.takeIf { it.isNotBlank() }
        } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE)
            == PackageManager.PERMISSION_GRANTED) {
            @Suppress("DEPRECATION")
            tm.line1Number?.takeIf { it.isNotBlank() }
        } else null
        result.add(
            mapOf(
                "slot" to 1,
                "number" to number,
                "carrier" to tm.networkOperatorName?.takeIf { it.isNotBlank() },
                "signal" to null
            )
        )
        return result
    }

    /** Best-effort “our” number for inbound `to` field (matches standalone agent). */
    fun primaryOwnNumber(context: Context): String {
        val sims = simPayloads(context)
        val n = sims.firstOrNull()?.get("number") as? String
        return n?.takeIf { it.isNotBlank() } ?: "unknown"
    }

    fun batteryPercent(context: Context): Int {
        return try {
            val batteryIntent = context.registerReceiver(
                null,
                android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED)
            )
            val level = batteryIntent?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = batteryIntent?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (level >= 0 && scale > 0) (level * 100 / scale) else -1
        } catch (_: Exception) {
            -1
        }
    }
}
