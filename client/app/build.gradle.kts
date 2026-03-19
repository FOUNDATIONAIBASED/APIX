plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace   = "com.apix.agent"
    compileSdk  = 36

    defaultConfig {
        applicationId   = "com.apix.agent"
        minSdk          = 21
        multiDexEnabled = true
        targetSdk       = 36
        versionCode     = (project.findProperty("android.versionCode") as String?)?.toIntOrNull() ?: 1
        versionName     = (project.findProperty("android.versionName") as String?) ?: "2.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Release signing — configured via CI secrets or local keystore.properties
    val keystoreFile = project.findProperty("android.storeFile") as String?
    if (keystoreFile != null && file(keystoreFile).exists()) {
        signingConfigs {
            create("release") {
                storeFile     = file(keystoreFile)
                storePassword = project.findProperty("android.storePassword") as String? ?: ""
                keyAlias      = project.findProperty("android.keyAlias")      as String? ?: ""
                keyPassword   = project.findProperty("android.keyPassword")   as String? ?: ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled   = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Use release signing if configured, otherwise unsigned
            val relCfg = signingConfigs.findByName("release")
            if (relCfg != null) signingConfig = relCfg
        }
        debug {
            applicationIdSuffix = ".debug"
            isDebuggable = true
        }
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.constraintlayout)
    implementation(libs.recyclerview)
    implementation(libs.cardview)
    implementation(libs.lifecycle.viewmodel.ktx)
    implementation(libs.lifecycle.livedata.ktx)
    implementation(libs.lifecycle.runtime.ktx)
    implementation(libs.okhttp)
    implementation(libs.gson)
    implementation(libs.swiperefreshlayout)
    implementation(libs.multidex)

    // QR code scanning for device pairing (works from API 14+)
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.zxing:core:3.5.3")

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
