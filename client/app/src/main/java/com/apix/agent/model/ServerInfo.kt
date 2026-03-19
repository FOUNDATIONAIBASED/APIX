package com.apix.agent.model

data class ServerInfo(
    val name: String,
    val host: String,
    val port: Int,
    val token: String? = null,
    val latencyMs: Long = -1L,
) {
    val wsUrl: String get() = "ws://$host:$port/ws"
    val apiUrl: String get() = "http://$host:$port/api/v1"
    val displayAddress: String get() = "$host:$port"
}
