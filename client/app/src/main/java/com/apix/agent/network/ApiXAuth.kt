package com.apix.agent.network

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object ApiXAuth {

    fun hmacSha256(data: String, secret: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val bytes = mac.doFinal(data.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun signPayload(payload: String, secret: String): String = hmacSha256(payload, secret)
}
