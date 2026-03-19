package com.apix.agent.ui.home

import android.content.Intent
import android.content.res.ColorStateList
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.apix.agent.R
import com.apix.agent.databinding.FragmentHomeBinding
import com.apix.agent.databinding.ItemSimCardBinding
import com.apix.agent.service.AgentForegroundService
import com.apix.agent.util.PreferenceManager
import com.apix.agent.util.SimUtils

class HomeFragment : Fragment() {

    private var _binding: FragmentHomeBinding? = null
    private val binding get() = _binding!!
    private lateinit var prefs: PreferenceManager
    private var paused = false

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        prefs = PreferenceManager(requireContext())

        binding.tvDeviceModel.text = android.os.Build.MODEL
        refreshSimCards()
        refreshBattery()
        updateStats(0, 0, 0)
        setStatus(AgentForegroundService.STATUS_OFFLINE, prefs.serverName ?: prefs.serverHost ?: "—")

        binding.btnPauseRelay.setOnClickListener {
            paused = !paused
            binding.btnPauseRelay.text = if (paused)
                getString(R.string.home_resume_relay)
            else
                getString(R.string.home_pause_relay)
        }
    }

    fun onStatusUpdate(intent: Intent) {
        val status     = intent.getStringExtra(AgentForegroundService.EXTRA_STATUS) ?: return
        val serverName = intent.getStringExtra(AgentForegroundService.EXTRA_SERVER_NAME) ?: "—"
        val sent       = intent.getIntExtra("sent_today", 0)
        val received   = intent.getIntExtra("received_today", 0)
        val failed     = intent.getIntExtra("failed_today", 0)

        activity?.runOnUiThread {
            setStatus(status, serverName)
            updateStats(sent, received, failed)
            refreshBattery()
        }
    }

    private fun setStatus(status: String, serverName: String) {
        binding.tvServerName.text = serverName
        when (status) {
            AgentForegroundService.STATUS_CONNECTED -> {
                binding.statusDot.background = ContextCompat.getDrawable(requireContext(), R.drawable.status_dot_green)
                binding.tvConnectionStatus.text = getString(R.string.home_status_connected)
                binding.tvConnectionStatus.setTextColor(ContextCompat.getColor(requireContext(), R.color.accent_green))
            }
            AgentForegroundService.STATUS_RECONNECTING -> {
                binding.statusDot.background = ContextCompat.getDrawable(requireContext(), R.drawable.status_dot_amber)
                binding.tvConnectionStatus.text = getString(R.string.home_status_reconnecting)
                binding.tvConnectionStatus.setTextColor(ContextCompat.getColor(requireContext(), R.color.accent_amber))
            }
            else -> {
                binding.statusDot.background = ContextCompat.getDrawable(requireContext(), R.drawable.status_dot_red)
                binding.tvConnectionStatus.text = getString(R.string.home_status_offline)
                binding.tvConnectionStatus.setTextColor(ContextCompat.getColor(requireContext(), R.color.accent_red))
            }
        }
    }

    private fun updateStats(sent: Int, received: Int, failed: Int) {
        binding.tvSentCount.text     = sent.toString()
        binding.tvReceivedCount.text = received.toString()
        binding.tvFailedCount.text   = failed.toString()
    }

    private fun refreshSimCards() {
        val sims = SimUtils.getSimCards(requireContext())
        binding.layoutSims.removeAllViews()

        if (sims.isEmpty()) {
            val tv = TextView(requireContext()).apply {
                text      = getString(R.string.home_no_sim)
                setTextColor(ContextCompat.getColor(requireContext(), R.color.text_hint))
                textSize  = 12f
            }
            binding.layoutSims.addView(tv)
            return
        }

        for (sim in sims) {
            val simBinding = ItemSimCardBinding.inflate(layoutInflater, binding.layoutSims, false)
            simBinding.tvSlot.text       = sim.slot.toString()
            simBinding.tvSimNumber.text  = sim.number ?: getString(R.string.home_no_sim)
            simBinding.tvCarrier.text    = sim.carrier ?: "Unknown"
            simBinding.tvSignal.text     = sim.signalDbm?.let { "${it} dBm" } ?: "—"

            // Signal bars
            val bars = SimUtils.signalBars(sim.signalDbm)
            val barViews = listOf(simBinding.bar1, simBinding.bar2, simBinding.bar3, simBinding.bar4)
            val activeColor = ContextCompat.getColor(requireContext(), R.color.accent_green)
            val inactiveColor = ContextCompat.getColor(requireContext(), R.color.text_hint)
            barViews.forEachIndexed { idx, barView ->
                barView.backgroundTintList = ColorStateList.valueOf(
                    if (idx < bars) activeColor else inactiveColor
                )
            }

            binding.layoutSims.addView(simBinding.root)
        }
    }

    private fun refreshBattery() {
        val bat = SimUtils.getBatteryLevel(requireContext())
        binding.tvBattery.text = if (bat >= 0) "$bat%" else "—"
        val color = when {
            bat >= 50 -> R.color.accent_green
            bat >= 20 -> R.color.accent_amber
            else      -> R.color.accent_red
        }
        binding.tvBattery.setTextColor(ContextCompat.getColor(requireContext(), color))
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
