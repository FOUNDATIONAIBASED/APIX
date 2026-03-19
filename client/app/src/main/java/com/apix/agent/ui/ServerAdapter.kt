package com.apix.agent.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.apix.agent.databinding.ItemServerBinding
import com.apix.agent.model.ServerInfo

class ServerAdapter(
    private val onConnect: (ServerInfo) -> Unit,
) : RecyclerView.Adapter<ServerAdapter.ViewHolder>() {

    private val items = mutableListOf<ServerInfo>()

    fun addServer(server: ServerInfo) {
        val existing = items.indexOfFirst { it.host == server.host && it.port == server.port }
        if (existing >= 0) {
            items[existing] = server
            notifyItemChanged(existing)
        } else {
            items.add(server)
            notifyItemInserted(items.size - 1)
        }
    }

    fun clear() {
        items.clear()
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemServerBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(items[position])
    }

    override fun getItemCount(): Int = items.size

    inner class ViewHolder(private val binding: ItemServerBinding) :
        RecyclerView.ViewHolder(binding.root) {

        fun bind(server: ServerInfo) {
            binding.tvServerName.text    = server.name
            binding.tvServerAddress.text = server.displayAddress
            binding.tvPing.text          = if (server.latencyMs >= 0) "${server.latencyMs}ms" else "—"
            binding.btnConnect.setOnClickListener { onConnect(server) }
            binding.root.setOnClickListener { onConnect(server) }
        }
    }
}
