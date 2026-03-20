/*
 * Stub API matching historical com.callcontrol:datashare for buildability.
 * Real Call Control integration requires the vendor AAR when available.
 */
package com.callcontrol.datashare

import android.content.Context
import android.content.Intent
import android.net.Uri

object CallControl {

    val LOOKUP_TEXT_URI: Uri = Uri.parse("content://com.callcontrol.datashare.stub/lookup/text")

    object Lookup {
        const val BLOCK_REASON = "block_reason"
    }

    class Report(
        val address: String,
        val extra: String? = null,
        val block: Boolean = true
    )

    @JvmStatic
    fun addRule(context: Context, reports: ArrayList<Report>, flags: Int) {
        // no-op stub
    }

    @JvmStatic
    fun openBlockedList(context: Context, flags: Int) {
        // no-op stub
    }
}
