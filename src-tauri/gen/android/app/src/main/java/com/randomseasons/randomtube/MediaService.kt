package com.randomseasons.randomtube

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Background play: a foreground "media playback" service with the media notification
 * (previous / play-pause / next, lock screen, headset buttons). Buttons call back into
 * the page through window.__rtMedia(cmd). Only framework classes, no extra libraries.
 */
class MediaService : Service() {
  companion object {
    private const val CH = "playback"
    @Volatile var running = false
  }

  private var session: MediaSession? = null
  private var wake: PowerManager.WakeLock? = null
  private var wifi: WifiManager.WifiLock? = null
  private var title = ""
  private var artist = ""
  private var playing = false
  private var artUrl = ""
  private var art: Bitmap? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager::class.java)
        .createNotificationChannel(NotificationChannel(CH, "Playback", NotificationManager.IMPORTANCE_LOW))
    }
    session = MediaSession(this, "RandomTube").apply {
      setCallback(object : MediaSession.Callback() {
        override fun onPlay() = js("play")
        override fun onPause() = js("pause")
        override fun onSkipToNext() = js("next")
        override fun onSkipToPrevious() = js("prev")
      })
      isActive = true
    }
    wake = (getSystemService(POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RandomTube:play").apply { setReferenceCounted(false) }
    @Suppress("DEPRECATION")
    wifi = (applicationContext.getSystemService(WIFI_SERVICE) as WifiManager)
      .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "RandomTube:play").apply { setReferenceCounted(false) }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    intent?.getStringExtra("cmd")?.let { js(it) }
    intent?.getStringExtra("state")?.let {
      try {
        val o = JSONObject(it)
        title = o.optString("title")
        artist = o.optString("artist")
        playing = o.optBoolean("playing")
        val url = o.optString("thumb")
        if (url != artUrl) {
          artUrl = url
          art = null
          loadArt(url)
        }
      } catch (_: Exception) {
      }
    }
    show()
    return START_NOT_STICKY
  }

  private fun js(cmd: String) {
    val w = MainActivity.web ?: return
    w.post { w.evaluateJavascript("window.__rtMedia&&window.__rtMedia('$cmd')", null) }
  }

  private fun action(icon: Int, label: String, cmd: String, code: Int): Notification.Action {
    val pi = PendingIntent.getService(
      this, code, Intent(this, MediaService::class.java).putExtra("cmd", cmd),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return Notification.Action.Builder(Icon.createWithResource(this, icon), label, pi).build()
  }

  private fun show() {
    val s = session ?: return
    s.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, title)
        .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
        .apply { art?.let { putBitmap(MediaMetadata.METADATA_KEY_ART, it) } }
        .build()
    )
    s.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS
        )
        .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
        .build()
    )
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE
    )
    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CH) else @Suppress("DEPRECATION") Notification.Builder(this)
    b.setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(title)
      .setContentText(artist)
      .setContentIntent(open)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(playing)
      .addAction(action(android.R.drawable.ic_media_previous, "Previous", "prev", 1))
      .addAction(
        if (playing) action(android.R.drawable.ic_media_pause, "Pause", "pause", 2)
        else action(android.R.drawable.ic_media_play, "Play", "play", 2)
      )
      .addAction(action(android.R.drawable.ic_media_next, "Next", "next", 3))
      .setStyle(Notification.MediaStyle().setMediaSession(s.sessionToken).setShowActionsInCompactView(0, 1, 2))
    art?.let { b.setLargeIcon(it) }
    val n = b.build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    else startForeground(1, n)
    if (playing) {
      wake?.acquire(6 * 60 * 60 * 1000L)
      wifi?.acquire()
    } else {
      wake?.takeIf { it.isHeld }?.release()
      wifi?.takeIf { it.isHeld }?.release()
    }
  }

  private fun loadArt(url: String) {
    if (url.isEmpty()) return
    Thread {
      try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 8000
        val bm = c.inputStream.use { BitmapFactory.decodeStream(it) }
        Handler(Looper.getMainLooper()).post {
          if (url == artUrl && bm != null) {
            art = bm
            if (running) show()
          }
        }
      } catch (_: Exception) {
      }
    }.start()
  }

  // swiping the app away from recents stops the music
  override fun onTaskRemoved(rootIntent: Intent?) {
    MainActivity.active = false
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    session?.release()
    session = null
    wake?.takeIf { it.isHeld }?.release()
    wifi?.takeIf { it.isHeld }?.release()
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
}
