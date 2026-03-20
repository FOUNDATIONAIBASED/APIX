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

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import com.moez.QKSMS.R
import com.moez.QKSMS.common.base.QkThemedActivity
import dagger.android.AndroidInjection
import kotlinx.android.synthetic.main.activity_gateway.*

class GatewayActivity : QkThemedActivity() {

    private lateinit var gatewayPrefs: GatewayPreferences

    companion object {
        private const val REQ_QR_SCAN = 4402
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        AndroidInjection.inject(this)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_gateway)
        showBackButton(true)
        title = getString(R.string.gateway_title)

        gatewayPrefs = GatewayPreferences(this)
        gatewayHost.setText(gatewayPrefs.serverHost ?: "")
        gatewayPort.setText(gatewayPrefs.serverPort.toString())
        gatewayToken.setText(gatewayPrefs.deviceToken ?: "")
        gatewayPairing.setText(gatewayPrefs.pairingToken ?: "")
        gatewayTls.isChecked = gatewayPrefs.useTls

        gatewayScanQr.setOnClickListener {
            startActivityForResult(Intent(this, GatewayQrScanActivity::class.java), REQ_QR_SCAN)
        }

        gatewaySave.setOnClickListener { savePrefs() }
        gatewayStart.setOnClickListener {
            savePrefs()
            GatewayRelayService.start(this)
            refreshStatusText()
        }
        gatewayStop.setOnClickListener {
            GatewayRelayService.stop(this)
            refreshStatusText()
        }
        gatewayResetSmsCursor.setOnClickListener {
            gatewayPrefs.lastSmsContentId = -1L
            Toast.makeText(this, R.string.gateway_reset_sms_cursor_help, Toast.LENGTH_LONG).show()
        }
        refreshStatusText()
    }

    override fun onResume() {
        super.onResume()
        refreshStatusText()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_QR_SCAN && resultCode == RESULT_OK) {
            gatewayPrefs = GatewayPreferences(this)
            gatewayHost.setText(gatewayPrefs.serverHost ?: "")
            gatewayPort.setText(gatewayPrefs.serverPort.toString())
            gatewayPairing.setText(gatewayPrefs.pairingToken ?: "")
            gatewayTls.isChecked = gatewayPrefs.useTls
            Toast.makeText(this, R.string.gateway_qr_ok, Toast.LENGTH_SHORT).show()
        }
    }

    private fun savePrefs() {
        gatewayPrefs.serverHost = gatewayHost.text?.toString()?.trim()
        gatewayPrefs.serverPort = gatewayPort.text?.toString()?.toIntOrNull()?.coerceIn(1, 65535) ?: 3000
        val tok = gatewayToken.text?.toString()?.trim()
        gatewayPrefs.deviceToken = tok?.takeIf { it.isNotEmpty() }
        val pair = gatewayPairing.text?.toString()?.trim()
        gatewayPrefs.pairingToken = pair?.takeIf { it.isNotEmpty() }
        gatewayPrefs.useTls = gatewayTls.isChecked
    }

    private fun refreshStatusText() {
        gatewayStatus.text = getString(
            R.string.gateway_status,
            getString(R.string.gateway_status_hint_saved)
        )
    }
}
