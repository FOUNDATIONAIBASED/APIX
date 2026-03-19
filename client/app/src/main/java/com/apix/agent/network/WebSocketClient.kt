package com.apix.agent.network

import android.os.Build
import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.TlsVersion
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.IOException
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

class WebSocketClient(private val wsUrl: String) {

    interface Listener {
        fun onConnected()
        fun onMessage(type: String, payload: JsonObject)
        fun onDisconnected(reason: String)
        fun onError(error: String)
    }

    private val tag = "WsClient"
    private val gson = Gson()

    private var webSocket: WebSocket? = null
    private var listener: Listener? = null
    private val connected = AtomicBoolean(false)
    private var reconnectAttempts = 0
    private var reconnectJob: Thread? = null
    private var shouldReconnect = true

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)   // No read timeout for WebSocket
        .writeTimeout(10, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .apply {
            // Android 4.x (API 16-20) supports TLS 1.2 but does not enable it by default.
            // Explicitly configure it so that wss:// connections work on these versions.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
                try {
                    val trustManager = buildTrustManager()
                    val sslContext = SSLContext.getInstance("TLS")
                    sslContext.init(null, arrayOf(trustManager), null)
                    sslSocketFactory(Tls12SocketFactory(sslContext.socketFactory), trustManager)
                    connectionSpecs(
                        listOf(
                            ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS)
                                .tlsVersions(TlsVersion.TLS_1_2, TlsVersion.TLS_1_1)
                                .build(),
                            ConnectionSpec.CLEARTEXT,
                        )
                    )
                } catch (e: Exception) {
                    Log.w(tag, "Could not configure TLS 1.2: ${e.message}")
                }
            }
        }
        .build()

    fun connect(listener: Listener) {
        this.listener = listener
        shouldReconnect = true
        reconnectAttempts = 0
        doConnect()
    }

    private fun doConnect() {
        Log.d(tag, "Connecting to $wsUrl")
        val request = Request.Builder().url(wsUrl).build()
        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.d(tag, "WebSocket opened")
                connected.set(true)
                reconnectAttempts = 0
                listener?.onConnected()
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val obj = gson.fromJson(text, JsonObject::class.java)
                    val type = obj.get("type")?.asString ?: return
                    listener?.onMessage(type, obj)
                } catch (e: Exception) {
                    Log.e(tag, "Failed to parse message: $text", e)
                }
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                onMessage(ws, bytes.utf8())
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                Log.d(tag, "WebSocket closing: $code $reason")
                ws.close(1000, null)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.d(tag, "WebSocket closed: $code $reason")
                connected.set(false)
                listener?.onDisconnected(reason)
                if (shouldReconnect) scheduleReconnect()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.e(tag, "WebSocket failure: ${t.message}")
                connected.set(false)
                listener?.onError(t.message ?: "Connection failed")
                if (shouldReconnect) scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        reconnectJob?.interrupt()
        reconnectJob = Thread {
            val delay = backoffDelay(reconnectAttempts)
            Log.d(tag, "Reconnect attempt ${reconnectAttempts + 1} in ${delay}ms")
            try {
                Thread.sleep(delay)
            } catch (e: InterruptedException) {
                return@Thread
            }
            reconnectAttempts++
            if (shouldReconnect) doConnect()
        }.also { it.isDaemon = true; it.start() }
    }

    private fun backoffDelay(attempt: Int): Long {
        val base = 1000L * (1L shl attempt.coerceAtMost(5))   // 1s, 2s, 4s, 8s, 16s, 32s max
        return base.coerceAtMost(30_000L)
    }

    fun send(data: Map<String, Any?>) {
        if (!connected.get()) {
            Log.w(tag, "Cannot send: not connected")
            return
        }
        try {
            val json = gson.toJson(data)
            webSocket?.send(json)
        } catch (e: Exception) {
            Log.e(tag, "Send failed", e)
        }
    }

    fun sendRaw(json: String) {
        webSocket?.send(json)
    }

    fun disconnect() {
        shouldReconnect = false
        reconnectJob?.interrupt()
        reconnectJob = null
        webSocket?.close(1000, "User disconnect")
        webSocket = null
        connected.set(false)
    }

    fun isConnected(): Boolean = connected.get()

    // ── TLS 1.2 helpers (API 16-20 only) ──────────────────────────────

    private fun buildTrustManager(): X509TrustManager {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(null as KeyStore?)
        return factory.trustManagers
            .filterIsInstance<X509TrustManager>()
            .first()
    }

    /**
     * SSLSocketFactory wrapper that forces TLS 1.2 and TLS 1.1 to be enabled on every
     * socket it creates. Android 4.x (API 16-20) supports these versions but excludes them
     * from the enabled list by default, causing handshake failures on modern servers.
     */
    private class Tls12SocketFactory(private val delegate: SSLSocketFactory) : SSLSocketFactory() {

        private val tlsVersions = arrayOf("TLSv1.2", "TLSv1.1")

        override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites

        override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites

        @Throws(IOException::class)
        override fun createSocket(s: Socket, host: String, port: Int, autoClose: Boolean): Socket =
            patch(delegate.createSocket(s, host, port, autoClose))

        @Throws(IOException::class)
        override fun createSocket(host: String, port: Int): Socket =
            patch(delegate.createSocket(host, port))

        @Throws(IOException::class)
        override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
            patch(delegate.createSocket(host, port, localHost, localPort))

        @Throws(IOException::class)
        override fun createSocket(host: InetAddress, port: Int): Socket =
            patch(delegate.createSocket(host, port))

        @Throws(IOException::class)
        override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
            patch(delegate.createSocket(address, port, localAddress, localPort))

        private fun patch(socket: Socket): Socket {
            if (socket is SSLSocket) {
                val supported = socket.supportedProtocols
                val toEnable = tlsVersions.filter { it in supported }.toTypedArray()
                if (toEnable.isNotEmpty()) {
                    socket.enabledProtocols = toEnable
                }
            }
            return socket
        }
    }
}
