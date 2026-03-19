package com.apix.agent.ui.log

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import com.apix.agent.R
import com.apix.agent.databinding.ItemLogEntryBinding
import com.apix.agent.model.Message
import com.apix.agent.model.MessageDirection
import com.apix.agent.model.MessageStatus
import com.apix.agent.model.MessageType
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class LogAdapter : RecyclerView.Adapter<LogAdapter.ViewHolder>() {

    private val allItems  = mutableListOf<Message>()
    private val items     = mutableListOf<Message>()
    private val timeFmt   = SimpleDateFormat("HH:mm", Locale.getDefault())
    private val dateFmt   = SimpleDateFormat("MM/dd", Locale.getDefault())

    enum class Filter { ALL, SENT, RECEIVED, FAILED }
    private var currentFilter = Filter.ALL

    fun setFilter(filter: Filter) {
        currentFilter = filter
        applyFilter()
    }

    fun addMessage(msg: Message) {
        allItems.add(0, msg)
        applyFilter()
    }

    fun setMessages(messages: List<Message>) {
        allItems.clear()
        allItems.addAll(messages)
        applyFilter()
    }

    private fun applyFilter() {
        items.clear()
        items.addAll(when (currentFilter) {
            Filter.ALL      -> allItems
            Filter.SENT     -> allItems.filter { it.direction == MessageDirection.OUTBOUND }
            Filter.RECEIVED -> allItems.filter { it.direction == MessageDirection.INBOUND }
            Filter.FAILED   -> allItems.filter { it.status == MessageStatus.FAILED }
        })
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemLogEntryBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(items[position])
    }

    override fun getItemCount(): Int = items.size

    inner class ViewHolder(private val b: ItemLogEntryBinding) : RecyclerView.ViewHolder(b.root) {

        fun bind(msg: Message) {
            val ctx = b.root.context

            // Direction arrow + colour
            if (msg.direction == MessageDirection.OUTBOUND) {
                b.tvDirection.text = "↑"
                b.tvDirection.setTextColor(ContextCompat.getColor(ctx, R.color.accent_blue))
                b.tvDirection.setBackgroundResource(R.drawable.bg_chip_blue)
                b.tvNumber.text = msg.to
            } else {
                b.tvDirection.text = "↓"
                b.tvDirection.setTextColor(ContextCompat.getColor(ctx, R.color.accent_green))
                b.tvDirection.setBackgroundResource(R.drawable.bg_chip_green)
                b.tvNumber.text = msg.from
            }

            b.tvPreview.text = msg.body.ifBlank { "(media)" }

            // MMS badge
            b.tvMmsBadge.visibility = if (msg.type == MessageType.MMS) View.VISIBLE else View.GONE

            // Timestamp
            val date = Date(msg.timestamp)
            val today = Date()
            b.tvTimestamp.text = if (
                SimpleDateFormat("yyyyMMdd", Locale.getDefault()).format(date) ==
                SimpleDateFormat("yyyyMMdd", Locale.getDefault()).format(today)
            ) {
                timeFmt.format(date)
            } else {
                dateFmt.format(date)
            }

            // Status chip
            val (statusText, statusColorRes, statusBgRes) = when (msg.status) {
                MessageStatus.DELIVERED -> Triple("delivered", R.color.accent_green,  R.drawable.bg_chip_green)
                MessageStatus.SENT      -> Triple("sent",      R.color.accent_blue,   R.drawable.bg_chip_blue)
                MessageStatus.RECEIVED  -> Triple("received",  R.color.accent_cyan,   R.drawable.bg_chip_blue)
                MessageStatus.FAILED    -> Triple("failed",    R.color.accent_red,    R.drawable.bg_chip_red)
                MessageStatus.QUEUED    -> Triple("queued",    R.color.accent_amber,  R.drawable.bg_chip_amber)
            }
            b.tvStatus.text = statusText
            b.tvStatus.setTextColor(ContextCompat.getColor(ctx, statusColorRes))
            b.tvStatus.setBackgroundResource(statusBgRes)
        }
    }
}

