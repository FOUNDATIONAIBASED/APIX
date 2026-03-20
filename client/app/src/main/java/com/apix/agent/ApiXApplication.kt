package com.apix.agent

import android.app.Application
import android.util.Log

class ApiXApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        Log.i("ApiXApplication", "Apix CLI started")
    }
}
