package com.apix.agent.model

enum class MessageDirection { INBOUND, OUTBOUND }
enum class MessageType      { SMS, MMS }
enum class MessageStatus    { QUEUED, SENT, DELIVERED, FAILED, RECEIVED }

data class Message(
    val id: String,
    val direction: MessageDirection,
    val from: String,
    val to: String,
    val body: String,
    val type: MessageType = MessageType.SMS,
    val status: MessageStatus = MessageStatus.QUEUED,
    val timestamp: Long = System.currentTimeMillis(),
    val mediaUri: String? = null,
)
