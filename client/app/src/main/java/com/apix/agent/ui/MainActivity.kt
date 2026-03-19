package com.apix.agent.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.apix.agent.R
import com.apix.agent.databinding.ActivityMainBinding
import com.apix.agent.service.AgentForegroundService
import com.apix.agent.ui.home.HomeFragment
import com.apix.agent.ui.log.LogFragment
import com.apix.agent.ui.settings.SettingsFragment
import com.apix.agent.util.PreferenceManager

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: PreferenceManager

    private val homeFragment     = HomeFragment()
    private val logFragment      = LogFragment()
    private val settingsFragment = SettingsFragment()
    private var activeFragment: Fragment = homeFragment

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != AgentForegroundService.ACTION_STATUS_UPDATE) return
            // Forward to HomeFragment if visible
            val home = supportFragmentManager.findFragmentByTag("home") as? HomeFragment
            home?.onStatusUpdate(intent)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = PreferenceManager(this)

        setupFragments()
        setupBottomNav()
        startAgentService()

        val filter = IntentFilter(AgentForegroundService.ACTION_STATUS_UPDATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(statusReceiver, filter)
        }
    }

    private fun setupFragments() {
        supportFragmentManager.beginTransaction()
            .add(R.id.fragmentContainer, settingsFragment, "settings").hide(settingsFragment)
            .add(R.id.fragmentContainer, logFragment, "log").hide(logFragment)
            .add(R.id.fragmentContainer, homeFragment, "home")
            .commit()
    }

    private fun setupBottomNav() {
        binding.bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_home     -> { switchFragment(homeFragment, "Home");     true }
                R.id.nav_log      -> { switchFragment(logFragment, "Log");       true }
                R.id.nav_settings -> { switchFragment(settingsFragment, "Settings"); true }
                else              -> false
            }
        }
    }

    private fun switchFragment(fragment: Fragment, title: String) {
        supportFragmentManager.beginTransaction()
            .hide(activeFragment)
            .show(fragment)
            .commit()
        activeFragment = fragment
        binding.tvTopTitle.text = title
    }

    private fun startAgentService() {
        if (!prefs.isServerConfigured()) return
        val intent = Intent(this, AgentForegroundService::class.java)
        ContextCompat.startForegroundService(this, intent)
    }

    fun navigateToDiscover() {
        prefs.clearServer()
        stopService(Intent(this, AgentForegroundService::class.java))
        startActivity(Intent(this, DiscoverActivity::class.java))
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(statusReceiver) } catch (_: Exception) {}
    }
}
