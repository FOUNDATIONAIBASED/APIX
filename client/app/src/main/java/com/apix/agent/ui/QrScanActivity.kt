package com.apix.agent.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.SurfaceHolder
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.apix.agent.R
import com.apix.agent.databinding.ActivityQrScanBinding
import com.apix.agent.model.ServerInfo
import com.apix.agent.network.ServerAnnounce
import com.apix.agent.util.PreferenceManager
import com.google.zxing.BarcodeFormat
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.BinaryBitmap
import com.google.zxing.common.HybridBinarizer
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import org.json.JSONObject
import java.net.URI

/**
 * QR Code scanner for pairing with ApiX Gateway server.
 *
 * Scans the QR code shown in the management UI at /devices
 * and extracts: WebSocket URLs, pairing token, and server name.
 *
 * Uses ZXing Embedded (journeyapps) for the scanner UI.
 */
class QrScanActivity : AppCompatActivity() {

    private lateinit var binding: ActivityQrScanBinding
    private lateinit var prefs: PreferenceManager
    private var scanning = true

    companion object {
        private const val TAG = "QrScan"
        private const val CAMERA_PERM_CODE = 200
        const val RESULT_SERVER_CONFIGURED = 42
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityQrScanBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = PreferenceManager(this)

        supportActionBar?.apply {
            title = "Scan Gateway QR Code"
            setDisplayHomeAsUpEnabled(true)
        }

        binding.tvInstruction.text = "Point camera at the QR code shown in\nthe ApiX Gateway management console → Devices"

        binding.btnManualEntry.setOnClickListener {
            startActivity(Intent(this, DiscoverActivity::class.java))
            finish()
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), CAMERA_PERM_CODE)
        } else {
            startScanner()
        }
    }

    private fun startScanner() {
        binding.barcodeView.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                if (!scanning) return
                scanning = false
                binding.barcodeView.pause()
                handleQrResult(result.text)
            }
        })
        binding.barcodeView.resume()
    }

    private fun handleQrResult(raw: String) {
        Log.d(TAG, "QR scanned: ${raw.take(120)}")
        try {
            val json     = JSONObject(raw)
            val version  = json.optInt("v", 1)
            val name     = json.optString("name", "ApiX Gateway")
            val token    = json.optString("token", "").takeIf { it.isNotBlank() }
            val port     = json.optInt("port", 3000)
            val urlsArr  = json.optJSONArray("urls")

            if (urlsArr == null || urlsArr.length() == 0) {
                showError("Invalid QR code — no WebSocket URLs found")
                return
            }

            // Pick the first URL and parse host from it
            val firstUrl = urlsArr.getString(0)  // ws://192.168.x.x:3000/ws
            val uri      = URI(firstUrl)
            val host     = uri.host ?: run { showError("Cannot parse host from URL"); return }
            val wsPort   = if (uri.port > 0) uri.port else port

            // Build list of all URLs for fallback
            val allUrls = (0 until urlsArr.length()).map { urlsArr.getString(it) }

            // Persist pairing info
            prefs.serverHost  = host
            prefs.serverPort  = wsPort
            prefs.serverName  = name
            prefs.qrWsUrls   = org.json.JSONArray(allUrls).toString()
            if (!token.isNullOrBlank()) prefs.pairingToken = token

            runOnUiThread {
                binding.tvInstruction.text = "✓ Connected to $name\n$firstUrl"
                Toast.makeText(this, "Gateway configured! Starting agent…", Toast.LENGTH_SHORT).show()
            }

            ServerAnnounce.post(host, wsPort, prefs)

            // Brief visual feedback then launch
            binding.root.postDelayed({
                setResult(RESULT_SERVER_CONFIGURED)
                startActivity(Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                finish()
            }, 800L)

        } catch (e: Exception) {
            Log.e(TAG, "QR parse error: ${e.message}")
            showError("Invalid QR code format: ${e.message}")
        }
    }

    private fun showError(msg: String) {
        runOnUiThread {
            Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
            scanning = true
            binding.barcodeView.resume()
        }
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code == CAMERA_PERM_CODE &&
            results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED) {
            startScanner()
        } else {
            Toast.makeText(this, "Camera permission required for QR scanning", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onResume()  { super.onResume();  if (scanning) binding.barcodeView.resume() }
    override fun onPause()   { super.onPause();   binding.barcodeView.pause() }
    override fun onDestroy() { super.onDestroy(); binding.barcodeView.pause() }

    override fun onSupportNavigateUp(): Boolean { finish(); return true }
}
