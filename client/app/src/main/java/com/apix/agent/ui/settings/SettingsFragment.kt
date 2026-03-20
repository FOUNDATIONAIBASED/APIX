package com.apix.agent.ui.settings

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import com.apix.agent.BuildConfig
import com.apix.agent.databinding.FragmentSettingsBinding
import com.apix.agent.service.AgentForegroundService
import com.apix.agent.ui.MainActivity
import com.apix.agent.util.PreferenceManager

class SettingsFragment : Fragment() {

    private var _binding: FragmentSettingsBinding? = null
    private val binding get() = _binding!!
    private lateinit var prefs: PreferenceManager

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentSettingsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        prefs = PreferenceManager(requireContext())

        loadValues()
        setupListeners()
    }

    private fun loadValues() {
        val serverDisplay = prefs.serverName
            ?: prefs.serverHost?.let { "$it:${prefs.serverPort}" }
            ?: "Not connected"

        binding.tvConnectedServer.text       = serverDisplay
        binding.switchBootStart.isChecked    = prefs.startOnBoot
        binding.switchMms.isChecked          = prefs.mmsEnabled
        binding.switchDebugUiLogs.isChecked  = prefs.debugUiLogs
        binding.etWsPing.setText(prefs.wsPingIntervalSeconds.toString())
        binding.etHeartbeat.setText(prefs.heartbeatIntervalSeconds.toString())
        binding.tvVersion.text               = BuildConfig.VERSION_NAME
        binding.tvDeviceId.text              = prefs.deviceId ?: "—"
    }

    private fun setupListeners() {
        binding.switchBootStart.setOnCheckedChangeListener { _, checked ->
            prefs.startOnBoot = checked
        }

        binding.switchMms.setOnCheckedChangeListener { _, checked ->
            prefs.mmsEnabled = checked
        }

        binding.switchDebugUiLogs.setOnCheckedChangeListener { _, checked ->
            prefs.debugUiLogs = checked
        }

        binding.btnDisconnect.setOnClickListener {
            requireActivity().stopService(
                Intent(requireContext(), AgentForegroundService::class.java)
            )
            (activity as? MainActivity)?.navigateToDiscover()
        }

        binding.btnSwitchServer.setOnClickListener {
            requireActivity().stopService(
                Intent(requireContext(), AgentForegroundService::class.java)
            )
            (activity as? MainActivity)?.navigateToDiscover()
        }

        binding.etWsPing.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                val v = binding.etWsPing.text.toString().toIntOrNull() ?: 30
                prefs.wsPingIntervalSeconds = v.coerceIn(5, 300)
            }
        }

        binding.etHeartbeat.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                val v = binding.etHeartbeat.text.toString().toIntOrNull() ?: 30
                prefs.heartbeatIntervalSeconds = v.coerceIn(10, 300)
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
