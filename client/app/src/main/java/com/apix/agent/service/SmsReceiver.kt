package com.apix.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SmsMessage
import android.util.Log
import com.apix.agent.model.Message
import com.apix.agent.model.MessageDirection
import com.apix.agent.model.MessageStatus
import com.apix.agent.model.MessageType

class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isNullOrEmpty()) return

        // Group multi-part SMS by sender
        val senders = mutableMapOf<String, StringBuilder>()
        var latestSms: SmsMessage? = null

        for (sms in messages) {
            val sender = sms.displayOriginatingAddress ?: continue
            senders.getOrPut(sender) { StringBuilder() }.append(sms.messageBody ?: "")
            latestSms = sms
        }

        for ((sender, bodyBuilder) in senders) {
            val body = bodyBuilder.toString()
            Log.d("SmsReceiver", "SMS received from $sender: ${body.take(40)}")

            val msg = Message(
                id        = "local_${System.currentTimeMillis()}",
                direction = MessageDirection.INBOUND,
                from      = sender,
                to        = latestSms?.serviceCenterAddress ?: "unknown",
                body      = body,
                type      = MessageType.SMS,
                status    = MessageStatus.RECEIVED,
                timestamp = latestSms?.timestampMillis ?: System.currentTimeMillis(),
            )

            // Broadcast to AgentForegroundService via local broadcast
            val relayIntent = Intent(AgentForegroundService.ACTION_SMS_RECEIVED).apply {
                putExtra(AgentForegroundService.EXTRA_FROM,    msg.from)
                putExtra(AgentForegroundService.EXTRA_BODY,    msg.body)
                putExtra(AgentForegroundService.EXTRA_TIMESTAMP, msg.timestamp)
            }
            context.sendBroadcast(relayIntent)
        }
    }
}
