/*
 * Copyright (C) 2025
 *
 * This file is part of QKSMS (ApiX gateway integration).
 */
package com.moez.QKSMS.feature.gateway

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.moez.QKSMS.R
import com.moez.QKSMS.common.base.QkThemedActivity
import dagger.android.AndroidInjection
import org.json.JSONObject
import timber.log.Timber
import java.net.URI

/**
 * Scans the QR code from ApiX Gateway → Devices → "Pair New Device via QR"
 * (same JSON payload as the standalone ApiX Agent).
 */
class GatewayQrScanActivity : QkThemedActivity() {

    private lateinit var barcodeView: DecoratedBarcodeView
    /** Gateway settings (distinct from [QkThemedActivity.prefs] which is theme [Preferences]). */
    private lateinit var gatewayPrefs: GatewayPreferences
    private var scanning = true

    companion object {
        private const val CAMERA_PERM = 4401
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        AndroidInjection.inject(this)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_gateway_qr)
        showBackButton(true)
        title = getString(R.string.gateway_scan_qr_title)

        gatewayPrefs = GatewayPreferences(this)
        barcodeView = findViewById(R.id.gatewayBarcodeView)

        findViewById<android.view.View>(R.id.gatewayQrCancel).setOnClickListener { finish() }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), CAMERA_PERM)
        } else {
            startScan()
        }
    }

    private fun startScan() {
        barcodeView.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                if (!scanning) return
                scanning = false
                barcodeView.pause()
                handlePayload(result.text)
            }
        })
        barcodeView.resume()
    }

    private fun handlePayload(raw: String) {
        try {
            val json = JSONObject(raw)
            val token = json.optString("token", "").takeIf { it.isNotBlank() }
            val portHint = json.optInt("port", 3000)
            val urlsArr = json.optJSONArray("urls")
            if (urlsArr == null || urlsArr.length() == 0) {
                showError(getString(R.string.gateway_qr_invalid))
                return
            }
            val firstUrl = urlsArr.getString(0)
            val uri = URI(firstUrl)
            val host = uri.host ?: run {
                showError(getString(R.string.gateway_qr_invalid))
                return
            }
            val scheme = uri.scheme ?: "ws"
            val wsPort = if (uri.port > 0) uri.port else portHint

            gatewayPrefs.serverHost = host
            gatewayPrefs.serverPort = wsPort
            gatewayPrefs.useTls = scheme.equals("wss", ignoreCase = true)
            if (!token.isNullOrBlank()) {
                gatewayPrefs.pairingToken = token
            }

            Toast.makeText(this, R.string.gateway_qr_ok, Toast.LENGTH_SHORT).show()
            setResult(RESULT_OK)
            finish()
        } catch (e: Exception) {
            Timber.e(e, "Gateway QR parse failed")
            showError(getString(R.string.gateway_qr_invalid))
        }
    }

    private fun showError(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
        scanning = true
        barcodeView.resume()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == CAMERA_PERM && grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startScan()
        } else {
            Toast.makeText(this, R.string.gateway_qr_need_camera, Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onResume() {
        super.onResume()
        if (scanning) barcodeView.resume()
    }

    override fun onPause() {
        super.onPause()
        barcodeView.pause()
    }
}
