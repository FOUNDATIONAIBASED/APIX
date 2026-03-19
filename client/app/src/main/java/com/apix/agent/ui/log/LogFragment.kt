package com.apix.agent.ui.log

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import com.apix.agent.R
import com.apix.agent.databinding.FragmentLogBinding
import com.google.android.material.tabs.TabLayout

class LogFragment : Fragment() {

    private var _binding: FragmentLogBinding? = null
    private val binding get() = _binding!!
    private lateinit var adapter: LogAdapter

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

        adapter = LogAdapter()
        binding.rvLog.layoutManager = LinearLayoutManager(requireContext())
        binding.rvLog.adapter = adapter

        // Tabs
        listOf(
            getString(R.string.log_tab_all),
            getString(R.string.log_tab_sent),
            getString(R.string.log_tab_received),
            getString(R.string.log_tab_failed),
        ).forEach { binding.tabLayout.addTab(binding.tabLayout.newTab().setText(it)) }

        binding.tabLayout.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) {
                val filter = when (tab.position) {
                    1    -> LogAdapter.Filter.SENT
                    2    -> LogAdapter.Filter.RECEIVED
                    3    -> LogAdapter.Filter.FAILED
                    else -> LogAdapter.Filter.ALL
                }
                adapter.setFilter(filter)
                updateEmptyState()
            }
            override fun onTabUnselected(tab: TabLayout.Tab?) {}
            override fun onTabReselected(tab: TabLayout.Tab?) {}
        })

        binding.swipeRefresh.setColorSchemeResources(R.color.accent_blue)
        binding.swipeRefresh.setProgressBackgroundColorSchemeResource(R.color.surface1)
        binding.swipeRefresh.setOnRefreshListener {
            binding.swipeRefresh.isRefreshing = false
        }

        updateEmptyState()
    }

    private fun updateEmptyState() {
        val empty = adapter.itemCount == 0
        binding.layoutEmpty.visibility = if (empty) View.VISIBLE else View.GONE
        binding.swipeRefresh.visibility = if (empty) View.GONE else View.VISIBLE
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
