package com.apix.agent.network

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import com.apix.agent.model.ServerInfo
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

class ServerDiscovery(private val context: Context) {

    interface Listener {
        fun onServerFound(server: ServerInfo)
        fun onDiscoveryStarted()
        fun onDiscoveryStopped()
        fun onDiscoveryError(error: String)
    }

    private val tag = "ServerDiscovery"
    private val nsdManager: NsdManager by lazy {
        context.getSystemService(Context.NSD_SERVICE) as NsdManager
    }

    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var isDiscovering = false
    private var listener: Listener? = null

    private val resolvedHosts = mutableSetOf<String>()

    fun startDiscovery(listener: Listener) {
        this.listener = listener
        resolvedHosts.clear()

        if (isDiscovering) {
            stopDiscovery()
        }

        discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(tag, "Discovery start failed: $errorCode")
                isDiscovering = false
                listener.onDiscoveryError("Discovery failed (code $errorCode)")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(tag, "Discovery stop failed: $errorCode")
            }

            override fun onDiscoveryStarted(serviceType: String) {
                Log.d(tag, "Discovery started for $serviceType")
                isDiscovering = true
                listener.onDiscoveryStarted()
            }

            override fun onDiscoveryStopped(serviceType: String) {
                Log.d(tag, "Discovery stopped")
                isDiscovering = false
                listener.onDiscoveryStopped()
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                Log.d(tag, "Service found: ${serviceInfo.serviceName}")
                resolveService(serviceInfo)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                Log.d(tag, "Service lost: ${serviceInfo.serviceName}")
            }
        }

        try {
            nsdManager.discoverServices("_apix._tcp", NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Exception) {
            Log.e(tag, "Failed to start discovery", e)
            listener.onDiscoveryError(e.message ?: "Unknown error")
        }
    }

    private fun resolveService(serviceInfo: NsdServiceInfo) {
        nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
            override fun onResolveFailed(service: NsdServiceInfo, errorCode: Int) {
                Log.e(tag, "Resolve failed: $errorCode for ${service.serviceName}")
            }

            override fun onServiceResolved(service: NsdServiceInfo) {
                val host = service.host?.hostAddress ?: return
                val port = service.port
                val key  = "$host:$port"

                if (resolvedHosts.contains(key)) return
                resolvedHosts.add(key)

                Log.d(tag, "Resolved: ${service.serviceName} → $host:$port")

                Thread {
                    val latency = pingServer(host, port)
                    val serverInfo = ServerInfo(
                        name      = service.serviceName,
                        host      = host,
                        port      = port,
                        latencyMs = latency,
                    )
                    listener?.onServerFound(serverInfo)
                }.start()
            }
        })
    }

    private fun pingServer(host: String, port: Int): Long {
        return try {
            val client = OkHttpClient.Builder()
                .connectTimeout(3, TimeUnit.SECONDS)
                .readTimeout(3, TimeUnit.SECONDS)
                .build()
            val start = System.currentTimeMillis()
            val response = client.newCall(
                Request.Builder().url("http://$host:$port/api/v1/status").build()
            ).execute()
            val latency = System.currentTimeMillis() - start
            response.close()
            latency
        } catch (e: Exception) {
            -1L
        }
    }

    fun stopDiscovery() {
        if (isDiscovering && discoveryListener != null) {
            try {
                nsdManager.stopServiceDiscovery(discoveryListener)
            } catch (e: Exception) {
                Log.e(tag, "Failed to stop discovery", e)
            }
        }
        discoveryListener = null
        isDiscovering = false
    }
}
