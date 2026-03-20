![QKSMS](https://user-images.githubusercontent.com/4358785/39079306-a5a409b6-44e5-11e8-8589-b4acd63b636e.jpg)

# QKSMS

[![Build Status](https://circleci.com/gh/moezbhatti/qksms/tree/master.svg?style=svg)](https://circleci.com/gh/moezbhatti/qksms/tree/master)
[![Crowdin](https://badges.crowdin.net/qksms/localized.svg)](https://crowdin.com/project/qksms)
[![Liberapay donation](https://img.shields.io/badge/donate-liberapay-yellow.svg)](https://liberapay.com/moezbhatti/)
[![Bitcoin donation](https://img.shields.io/badge/donate-bitcoin-yellow.svg)](https://qklabs.com/donate-btc/)
[![PayPal donation](https://img.shields.io/badge/donate-paypal-yellow.svg)](https://qklabs.com/donate)

QKSMS is an open source replacement to the [stock messaging app](https://github.com/android/platform_packages_apps_mms) on Android. It is currently available on the [Google Play Store](https://play.google.com/store/apps/details?id=com.moez.QKSMS) and on [F-Droid](https://f-droid.org/repository/browse/?fdid=com.moez.QKSMS)

<a href="https://play.google.com/store/apps/details?id=com.moez.QKSMS"><img src="https://play.google.com/intl/en_us/badges/images/generic/en_badge_web_generic.png" alt="Download on Google Play" height="100"></a><a href="https://f-droid.org/repository/browse/?fdid=com.moez.QKSMS"><img src="https://f-droid.org/badge/get-it-on.png" alt="Get it on F-Droid" height="100"></a>

## Reporting bugs

A great bug report contains a description of the problem and steps to reproduce the problem. We need to know what we're looking for and where to look for it.

When reporting a bug, please make sure to provide the following information:
- Steps to reproduce the issue
- QKSMS version
- Device / OS information

## Translations

If you'd like to add translations to QKSMS, please join the project on [Crowdin](https://crowdin.com/project/qksms). Translations that are committed directly to source files will not be accepted.

## Thank you

A special thank you to Jake ([@klinker41](https://github.com/klinker41)) and Luke Klinker ([@klinker24](https://github.com/klinker24)) for their work on [android-smsmms](https://github.com/klinker41/android-smsmms), which has been an unspeakably large help in implementing MMS into QKSMS.


## Contact

QKSMS is developed and maintained by [Moez Bhatti](https://github.com/moezbhatti). Feel free to reach out to moez@qklabs.com

## ApiX gateway (fork integration)

This tree adds an **ApiX gateway** entry in the main drawer. It runs a foreground service that:

- Connects to your ApiX server WebSocket (`ws://` or `wss://`, path `/ws`).
- Registers like the standalone Android agent (device token, optional one-time pairing token from QR).
- Sends outbound **SMS/MMS** through QKSMS’s normal `MessageRepository` pipeline.
- Forwards **inbound SMS** from the Telephony provider to the server as `sms_received` (cursor-based; no history replay after bootstrap).

**Build (this fork):** Gradle **7.6.x** (wrapper), Android Gradle Plugin **7.4.x**, **Kotlin 1.7.x**, `compileSdk` **33**, `targetSdk` **29**. Use **JDK 17** (or 11+) for the Gradle daemon:

```bash
cd test/qksms
./gradlew :presentation:assembleNoAnalyticsDebug
```

APK output: `presentation/build/outputs/apk/noAnalytics/debug/` (see `archivesBaseName` in `presentation/build.gradle`).

**CI:** GitHub Actions job `build-qksms` in the parent repo uses JDK 17 and Android SDK 33; see root `README.md`.

Cleartext `ws://` is allowed via `network_security_config` for local/homelab; prefer `wss://` when exposed beyond LAN.

## License

QKSMS is released under the **The GNU General Public License v3.0 (GPLv3)**, which can be found in the `LICENSE` file in the root of this project.
