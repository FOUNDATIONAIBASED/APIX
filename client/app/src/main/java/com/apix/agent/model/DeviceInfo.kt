package com.apix.agent.model

data class SimCard(
    val slot: Int,
    val number: String?,
    val carrier: String?,
    val signalDbm: Int?,
)

data class DeviceInfo(
    val model: String,
    val androidVersion: String,
    val sims: List<SimCard>,
    val battery: Int,
    val sentToday: Int = 0,
    val receivedToday: Int = 0,
)
