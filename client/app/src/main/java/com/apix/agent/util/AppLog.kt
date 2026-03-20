package com.apix.agent.util

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Ring buffer of debug lines for the Log tab (when enabled in Settings).
 */
object AppLog {
    private const val MAX = 400
    private val lines = ArrayDeque<String>(MAX + 1)
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    @Synchronized
    fun add(message: String) {
        val line = "${fmt.format(Date())} $message"
        while (lines.size >= MAX) lines.removeFirst()
        lines.addLast(line)
        listeners.forEach { runCatching { it() } }
    }

    @Synchronized
    fun snapshot(): List<String> = lines.toList()

    fun addListener(callback: () -> Unit): () -> Unit {
        listeners.add(callback)
        return { listeners.remove(callback) }
    }

    @Synchronized
    fun clear() {
        lines.clear()
        listeners.forEach { runCatching { it() } }
    }
}
