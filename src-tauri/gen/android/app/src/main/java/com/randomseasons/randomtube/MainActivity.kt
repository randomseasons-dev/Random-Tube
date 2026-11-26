package com.randomseasons.randomtube

import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  companion object {
    @Volatile var web: WebView? = null
    /** something is loaded in the player: keep the page running in the background */
    @Volatile var active = false
  }

  private val isTv: Boolean by lazy {
    (getSystemService(Context.UI_MODE_SERVICE) as UiModeManager).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
      packageManager.hasSystemFeature("android.software.leanback")
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.addJavascriptInterface(Bridge(), "RTAndroid")
  }

  // Tauri pauses the WebView when the app leaves the screen; undo that while playing so
  // the music keeps going with the screen off or another app open.
  override fun onPause() {
    super.onPause()
    if (active) web?.onResume()
  }

  override fun onDestroy() {
    if (isFinishing) stopService(Intent(this, MediaService::class.java))
    super.onDestroy()
  }

  inner class Bridge {
    @JavascriptInterface
    fun isTv(): Boolean = this@MainActivity.isTv

    /** player state for the media notification: {"title","artist","playing","thumb"} */
    @JavascriptInterface
    fun update(json: String) {
      active = true
      if (isTv) return
      val i = Intent(this@MainActivity, MediaService::class.java).putExtra("state", json)
      runOnUiThread {
        try {
          if (!MediaService.running && Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
        } catch (_: Exception) {
        }
      }
    }

    @JavascriptInterface
    fun stop() {
      active = false
      runOnUiThread { stopService(Intent(this@MainActivity, MediaService::class.java)) }
    }

    @JavascriptInterface
    fun setFullscreen(on: Boolean) {
      runOnUiThread {
        val c = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
          c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          c.hide(WindowInsetsCompat.Type.systemBars())
          if (!isTv) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
          c.show(WindowInsetsCompat.Type.systemBars())
          if (!isTv) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
      }
    }
  }
}
