package com.apix.agent

import android.util.Log
import androidx.multidex.MultiDexApplication

// MultiDexApplication is required for API < 21 (Dalvik VM) to exceed the 64K method limit.
// On API 21+ (ART), this is a no-op.
class ApiXApplication : MultiDexApplication() {

    override fun onCreate() {
        super.onCreate()
        Log.i("ApiXApplication", "ApiX Agent started")
    }
}
