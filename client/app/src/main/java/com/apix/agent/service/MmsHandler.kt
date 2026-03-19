package com.apix.agent.service

import com.apix.agent.R
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

@Suppress("DEPRECATION")
object MmsHandler {

    private const val TAG = "MmsHandler"

    /**
     * Send an MMS message. On API 21+ uses SmsManager.sendMultimediaMessage().
     * mediaBase64 is a base64-encoded media file (image, audio, etc.).
     * mediaType is the MIME type (e.g. "image/jpeg").
     */
    fun sendMms(
        context: Context,
        to: String,
        subject: String?,
        mediaBase64: String?,
        mediaType: String?,
        msgId: String,
    ) {
        // SmsManager.sendMultimediaMessage() was introduced in API 21 (Lollipop).
        // On Android 4.x (API 18-20) use Intent fallback: launch default MMS app with pre-filled data.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            sendMmsViaIntent(context, to, subject, mediaBase64, mediaType, msgId)
            return
        }

        try {
            val smsManager = getSmsManager(context)

            // Build PDU
            val pdu = buildPdu(
                context    = context,
                to         = to,
                subject    = subject ?: "",
                mediaBase64 = mediaBase64,
                mediaType  = mediaType ?: "image/jpeg",
            ) ?: run {
                Log.e(TAG, "Failed to build MMS PDU")
                return
            }

            // Write PDU to a temp file (required by sendMultimediaMessage)
            val pduFile = File(context.cacheDir, "mms_${msgId}.pdu")
            FileOutputStream(pduFile).use { it.write(pdu) }
            val contentUri = Uri.fromFile(pduFile)

            val sentIntent = PendingIntent.getBroadcast(
                context, 0,
                Intent(ACTION_MMS_SENT).putExtra("msgId", msgId),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )

            smsManager.sendMultimediaMessage(context, contentUri, null, null, sentIntent)
            Log.i(TAG, "MMS sent to $to")
        } catch (e: Exception) {
            Log.e(TAG, "MMS send failed", e)
        }
    }

    /**
     * Fallback for API 18-20: launch the default MMS app with recipient, subject, and optional
     * media pre-filled. The user must tap Send in the compose screen. There is no public API
     * for programmatic MMS send on these Android versions.
     */
    private fun sendMmsViaIntent(
        context: Context,
        to: String,
        subject: String?,
        mediaBase64: String?,
        mediaType: String?,
        msgId: String,
    ) {
        try {
            val intent = when {
                mediaBase64 != null && mediaType != null -> {
                    val bytes = android.util.Base64.decode(mediaBase64, android.util.Base64.DEFAULT)
                    val ext = when {
                        mediaType.contains("jpeg") || mediaType.contains("jpg") -> "jpg"
                        mediaType.contains("png") -> "png"
                        mediaType.contains("gif") -> "gif"
                        mediaType.contains("webp") -> "webp"
                        else -> "bin"
                    }
                    val file = File(context.cacheDir, "mms_share_${msgId}.$ext")
                    FileOutputStream(file).use { it.write(bytes) }
                    Intent(Intent.ACTION_SEND).apply {
                        type = mediaType
                        putExtra(Intent.EXTRA_STREAM, Uri.fromFile(file))
                        putExtra("address", to)
                        putExtra("subject", subject ?: "")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                }
                else -> {
                    Intent(Intent.ACTION_SENDTO).apply {
                        data = Uri.parse("mmsto:$to").buildUpon()
                            .appendQueryParameter("subject", subject ?: "")
                            .build()
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                }
            }
            val chooser = Intent.createChooser(intent, context.getString(R.string.mms_chooser_title)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            Log.i(TAG, "MMS compose opened for $to (API < 21 Intent fallback)")
        } catch (e: Exception) {
            Log.e(TAG, "MMS Intent fallback failed", e)
        }
    }

    private fun getSmsManager(context: Context): SmsManager {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }
    }

    /** Very minimal PDU builder for a simple MMS with one media part. */
    private fun buildPdu(
        context: Context,
        to: String,
        subject: String,
        mediaBase64: String?,
        mediaType: String,
    ): ByteArray? {
        return try {
            val baos = ByteArrayOutputStream()

            // X-Mms-Message-Type: m-send-req (0x80)
            baos.write(byteArrayOf(0x8C.toByte(), 0x80.toByte()))
            // X-Mms-Transaction-ID
            val txId = "TX${System.currentTimeMillis()}"
            baos.write(0x98.toByte().toInt())
            writeStringPdu(baos, txId)
            // X-Mms-MMS-Version: 1.2
            baos.write(byteArrayOf(0x8D.toByte(), 0x92.toByte()))
            // To header
            baos.write(0x97.toByte().toInt())
            writeStringPdu(baos, "$to/TYPE=PLMN")
            // Subject
            if (subject.isNotEmpty()) {
                baos.write(0x96.toByte().toInt())
                writeStringPdu(baos, subject)
            }
            // Content-Type: application/vnd.wap.multipart.related
            baos.write(byteArrayOf(0x84.toByte(), 0xB3.toByte()))

            if (mediaBase64 != null) {
                val mediaBytes = android.util.Base64.decode(mediaBase64, android.util.Base64.DEFAULT)
                baos.write(mediaBytes)
            }

            baos.toByteArray()
        } catch (e: Exception) {
            Log.e(TAG, "PDU build error", e)
            null
        }
    }

    private fun writeStringPdu(baos: ByteArrayOutputStream, s: String) {
        baos.write(s.toByteArray(Charsets.UTF_8))
        baos.write(0) // null terminator
    }

    const val ACTION_MMS_SENT     = "com.apix.agent.MMS_SENT"
    const val ACTION_MMS_RECEIVED = "com.apix.agent.MMS_RECEIVED"
}
