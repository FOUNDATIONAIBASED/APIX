package com.apix.agent.util

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.apix.agent.model.SimCard

object SimUtils {

    fun getSimCards(context: Context): List<SimCard> {
        val result = mutableListOf<SimCard>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            // API 22+: use SubscriptionManager for multi-SIM
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE)
                == PackageManager.PERMISSION_GRANTED) {
                val sm = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE)
                    as? SubscriptionManager
                val subs = sm?.activeSubscriptionInfoList
                if (!subs.isNullOrEmpty()) {
                    for (sub in subs) {
                        result.add(SimCard(
                            slot    = sub.simSlotIndex + 1,
                            number  = sub.number?.takeIf { it.isNotBlank() },
                            carrier = sub.carrierName?.toString(),
                            signalDbm = null,
                        ))
                    }
                    return result
                }
            }
        }

        // Fallback: single SIM via TelephonyManager
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        if (tm != null) {
            val number = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_NUMBERS)
                == PackageManager.PERMISSION_GRANTED) {
                tm.line1Number?.takeIf { it.isNotBlank() }
            } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE)
                == PackageManager.PERMISSION_GRANTED) {
                @Suppress("DEPRECATION")
                tm.line1Number?.takeIf { it.isNotBlank() }
            } else null

            result.add(SimCard(
                slot    = 1,
                number  = number,
                carrier = tm.networkOperatorName?.takeIf { it.isNotBlank() },
                signalDbm = null,
            ))
        }
        return result
    }

    fun getBatteryLevel(context: Context): Int {
        return try {
            val batteryIntent = context.registerReceiver(
                null,
                android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED)
            )
            val level  = batteryIntent?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale  = batteryIntent?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (level >= 0 && scale > 0) (level * 100 / scale) else -1
        } catch (e: Exception) {
            -1
        }
    }

    /** Returns a simple bars count (1–4) from signal dBm, or 0 for unknown. */
    fun signalBars(dbm: Int?): Int {
        if (dbm == null || dbm == 0) return 0
        return when {
            dbm >= -65 -> 4
            dbm >= -75 -> 3
            dbm >= -85 -> 2
            else       -> 1
        }
    }
}
