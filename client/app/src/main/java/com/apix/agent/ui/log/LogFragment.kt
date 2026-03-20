package com.apix.agent.ui.log

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import com.apix.agent.R
import com.apix.agent.databinding.FragmentLogBinding
import com.apix.agent.util.AppLog
import com.apix.agent.util.PreferenceManager
import com.google.android.material.tabs.TabLayout

class LogFragment : Fragment() {

    private var _binding: FragmentLogBinding? = null
    private val binding get() = _binding!!
    private lateinit var adapter: LogAdapter
    private lateinit var prefs: PreferenceManager
    private val handler = Handler(Looper.getMainLooper())
    private var debugMode = false
    private var appLogUnsub: (() -> Unit)? = null

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentLogBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        prefs = PreferenceManager(requireContext())
        adapter = LogAdapter()
        binding.rvLog.layoutManager = LinearLayoutManager(requireContext())
        binding.rvLog.adapter = adapter

        // Tabs
        listOf(
            getString(R.string.log_tab_all),
            getString(R.string.log_tab_sent),
            getString(R.string.log_tab_received),
            getString(R.string.log_tab_failed),
            getString(R.string.log_tab_debug),
        ).forEach { binding.tabLayout.addTab(binding.tabLayout.newTab().setText(it)) }

        binding.tabLayout.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) {
                debugMode = tab.position == 4
                binding.rvLog.visibility = if (debugMode) View.GONE else View.VISIBLE
                binding.scrollDebug.visibility = if (debugMode) View.VISIBLE else View.GONE
                if (debugMode) {
                    refreshDebugLog()
                } else {
                    val filter = when (tab.position) {
                        1    -> LogAdapter.Filter.SENT
                        2    -> LogAdapter.Filter.RECEIVED
                        3    -> LogAdapter.Filter.FAILED
                        else -> LogAdapter.Filter.ALL
                    }
                    adapter.setFilter(filter)
                }
                updateEmptyState()
            }
            override fun onTabUnselected(tab: TabLayout.Tab?) {}
            override fun onTabReselected(tab: TabLayout.Tab?) {}
        })

        binding.swipeRefresh.setColorSchemeResources(R.color.accent_blue)
        binding.swipeRefresh.setProgressBackgroundColorSchemeResource(R.color.surface1)
        binding.swipeRefresh.setOnRefreshListener {
            if (debugMode) refreshDebugLog()
            binding.swipeRefresh.isRefreshing = false
        }

        appLogUnsub = AppLog.addListener { handler.post { if (debugMode) refreshDebugLog() } }

        updateEmptyState()
    }

    private fun refreshDebugLog() {
        val lines = AppLog.snapshot()
        binding.tvDebugLog.text = if (lines.isEmpty()) {
            getString(R.string.log_debug_empty)
        } else {
            lines.joinToString("\n")
        }
        binding.scrollDebug.post {
            binding.scrollDebug.fullScroll(View.FOCUS_DOWN)
        }
        updateEmptyState()
    }

    private fun updateEmptyState() {
        if (debugMode) {
            val empty = binding.tvDebugLog.text.isNullOrBlank() ||
                binding.tvDebugLog.text == getString(R.string.log_debug_empty)
            binding.layoutEmpty.visibility = if (empty) View.VISIBLE else View.GONE
            binding.swipeRefresh.visibility = View.VISIBLE
            return
        }
        val empty = adapter.itemCount == 0
        binding.layoutEmpty.visibility = if (empty) View.VISIBLE else View.GONE
        binding.swipeRefresh.visibility = if (empty) View.GONE else View.VISIBLE
    }

    override fun onResume() {
        super.onResume()
        if (debugMode) refreshDebugLog()
    }

    override fun onDestroyView() {
        appLogUnsub?.invoke()
        appLogUnsub = null
        super.onDestroyView()
        _binding = null
    }
}
