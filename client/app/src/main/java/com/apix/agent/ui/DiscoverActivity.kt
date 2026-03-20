package com.apix.agent.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import com.apix.agent.R
import com.apix.agent.databinding.ActivityDiscoverBinding
import com.apix.agent.databinding.DialogManualServerBinding
import com.apix.agent.model.ServerInfo
import com.apix.agent.network.ServerAnnounce
import com.apix.agent.network.ServerDiscovery
import com.apix.agent.util.PreferenceManager

class DiscoverActivity : AppCompatActivity() {

    private lateinit var binding: ActivityDiscoverBinding
    private lateinit var prefs: PreferenceManager
    private lateinit var discovery: ServerDiscovery
    private lateinit var adapter: ServerAdapter

    companion object {
        private val REQUIRED_PERMISSIONS = buildList {
            add(Manifest.permission.SEND_SMS)
            add(Manifest.permission.RECEIVE_SMS)
            add(Manifest.permission.READ_SMS)
            add(Manifest.permission.READ_PHONE_STATE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                add(Manifest.permission.READ_PHONE_NUMBERS)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()

        private const val PERM_REQUEST_CODE = 100
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityDiscoverBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = PreferenceManager(this)
        discovery = ServerDiscovery(this)

        // If already configured, go straight to main
        if (prefs.isServerConfigured()) {
            launchMain()
            return
        }

        setupRecyclerView()
        setupClickListeners()
        requestPermissionsIfNeeded()
    }

    private fun setupRecyclerView() {
        adapter = ServerAdapter { server -> connectToServer(server) }
        binding.rvServers.layoutManager = LinearLayoutManager(this)
        binding.rvServers.adapter = adapter
    }

    private fun setupClickListeners() {
        binding.btnScan.setOnClickListener { startScan() }
        binding.btnManual.setOnClickListener { showManualDialog() }
        binding.btnQr.setOnClickListener {
            startActivityForResult(
                Intent(this, QrScanActivity::class.java),
                QrScanActivity.RESULT_SERVER_CONFIGURED
            )
        }
    }

    @Deprecated("Needed for API <31 compat")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == QrScanActivity.RESULT_SERVER_CONFIGURED
            && resultCode == QrScanActivity.RESULT_SERVER_CONFIGURED) {
            // QR scan succeeded, server already configured in prefs by QrScanActivity
            launchMain()
        }
    }

    private fun requestPermissionsIfNeeded() {
        val missing = REQUIRED_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), PERM_REQUEST_CODE)
        } else {
            startScan()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERM_REQUEST_CODE) {
            startScan()
        }
    }

    private fun startScan() {
        adapter.clear()
        binding.progressScan.visibility = View.VISIBLE
        binding.tvScanStatus.text = getString(R.string.discover_scanning)
        binding.layoutEmpty.visibility = View.GONE
        binding.rvServers.visibility = View.VISIBLE

        discovery.startDiscovery(object : ServerDiscovery.Listener {
            override fun onServerFound(server: ServerInfo) {
                runOnUiThread {
                    adapter.addServer(server)
                    binding.layoutEmpty.visibility = View.GONE
                    binding.tvServerCount.visibility = View.VISIBLE
                    binding.tvServerCount.text = "${adapter.itemCount} found"
                }
            }

            override fun onDiscoveryStarted() {
                runOnUiThread {
                    binding.tvScanStatus.text = getString(R.string.discover_scanning)
                }
            }

            override fun onDiscoveryStopped() {
                runOnUiThread {
                    binding.progressScan.visibility = View.GONE
                    if (adapter.itemCount == 0) {
                        binding.rvServers.visibility = View.GONE
                        binding.layoutEmpty.visibility = View.VISIBLE
                        binding.tvScanStatus.text = "Scan complete — no servers found"
                    } else {
                        binding.tvScanStatus.text = "Scan complete"
                    }
                }
            }

            override fun onDiscoveryError(error: String) {
                runOnUiThread {
                    binding.progressScan.visibility = View.GONE
                    binding.tvScanStatus.text = "Error: $error"
                    Toast.makeText(this@DiscoverActivity, error, Toast.LENGTH_SHORT).show()
                }
            }
        })

        // Auto-stop discovery after 15 seconds
        binding.root.postDelayed({ discovery.stopDiscovery() }, 15_000L)
    }

    private fun showManualDialog() {
        val dialogBinding = DialogManualServerBinding.inflate(layoutInflater)
        AlertDialog.Builder(this)
            .setView(dialogBinding.root)
            .setPositiveButton(getString(R.string.dialog_manual_connect)) { _, _ ->
                val host  = dialogBinding.etHost.text.toString().trim()
                val portStr = dialogBinding.etPort.text.toString().trim()
                val token = dialogBinding.etToken.text.toString().trim().takeIf { it.isNotEmpty() }
                val port  = portStr.toIntOrNull() ?: 3000

                if (host.isBlank()) {
                    Toast.makeText(this, "Host is required", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }

                connectToServer(ServerInfo(
                    name  = "Manual — $host",
                    host  = host,
                    port  = port,
                    token = token,
                ))
            }
            .setNegativeButton(getString(R.string.dialog_cancel), null)
            .create()
            .also { dialog ->
                dialog.window?.setBackgroundDrawableResource(R.color.bg2)
            }
            .show()
    }

    private fun connectToServer(server: ServerInfo) {
        discovery.stopDiscovery()

        // Save server details
        prefs.serverHost  = server.host
        prefs.serverPort  = server.port
        prefs.serverName  = server.name
        // Pairing token from QR/admin UI (one-time); not the persistent device token
        if (server.token != null) prefs.pairingToken = server.token

        ServerAnnounce.post(server.host, server.port, prefs)

        launchMain()
    }

    private fun launchMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        discovery.stopDiscovery()
    }
}
