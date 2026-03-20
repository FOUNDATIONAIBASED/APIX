package com.apix.agent.network

import android.os.Build
import android.util.Log
import com.apix.agent.util.AppLog
import com.apix.agent.util.PreferenceManager
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Lets the gateway know this device intends to connect (shows up under Security Center → discovery hints).
 */
object ServerAnnounce {

    private const val TAG = "ServerAnnounce"
    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .build()

    fun post(host: String, port: Int, prefs: PreferenceManager) {
        val json = JSONObject()
            .put("ws_host", host)
            .put("ws_port", port)
            .put("android_model", Build.MODEL ?: "")
        val body = RequestBody.create(
            MediaType.parse("application/json; charset=utf-8"),
            json.toString(),
        )
        val url = "http://$host:$port/api/v1/devices/announce"
        val req = Request.Builder().url(url).post(body).build()
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.d(TAG, "announce failed: ${e.message}")
                if (prefs.debugUiLogs) AppLog.add("announce: fail ${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                val code = response.code()
                response.close()
                if (prefs.debugUiLogs) AppLog.add("announce: HTTP $code")
            }
        })
    }
}
