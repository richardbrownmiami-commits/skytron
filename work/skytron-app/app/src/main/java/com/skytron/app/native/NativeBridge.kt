package com.skytron.app.native

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.skytron.app.MainActivity
import com.skytron.app.SkytronApp
import com.skytron.app.db.AppDatabase
import com.skytron.app.db.KVEntry
import com.skytron.app.db.SyncItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import java.util.Locale
import java.util.UUID

@SuppressLint("StaticFieldLeak")
class NativeBridge(
    private val activity: MainActivity,
    private val webView: WebView
) {
    private val scope = CoroutineScope(Dispatchers.IO)
    private val db: AppDatabase get() = SkytronApp.instance.database

    @JavascriptInterface
    fun reqPerm(permission: String): Boolean {
        return when (permission.lowercase()) {
            "camera" -> checkAndRequest(Manifest.permission.CAMERA)
            "microphone" -> checkAndRequest(Manifest.permission.RECORD_AUDIO)
            "location" -> checkAndRequest(Manifest.permission.ACCESS_FINE_LOCATION)
            "storage" -> checkAndRequest(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_IMAGES
                else Manifest.permission.READ_EXTERNAL_STORAGE
            )
            else -> false
        }
    }

    private fun checkAndRequest(permission: String): Boolean {
        if (ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED) return true
        activity.runOnUiThread {
            ActivityCompat.requestPermissions(activity, arrayOf(permission), 100)
        }
        return false
    }

    @JavascriptInterface
    fun takePic(): String {
        activity.runOnUiThread {
            activity.takePicture()
        }
        return ""
    }

    @JavascriptInterface
    fun getLoc(): String {
        return try {
            if (ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                return ""
            }
            val lm = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            val loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            if (loc != null) """{"lat":${loc.latitude},"lng":${loc.longitude}}""" else ""
        } catch (e: Exception) { "" }
    }

    @JavascriptInterface
    fun getDev(): String {
        return try {
            """{"model":"${Build.MODEL}","brand":"${Build.BRAND}","sdk":${Build.VERSION.SDK_INT},"release":"${Build.VERSION.RELEASE}","manufacturer":"${Build.MANUFACTURER}"}"""
        } catch (e: Exception) { "{}" }
    }

    @JavascriptInterface
    fun stt(): String {
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return ""
        }
        var result = ""
        val latch = java.util.concurrent.CountDownLatch(1)
        activity.runOnUiThread {
            try {
                val recognizer = SpeechRecognizer.createSpeechRecognizer(activity)
                recognizer.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: android.os.Bundle?) {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onError(error: Int) { 
                        latch.countDown()
                        recognizer.destroy()
                    }
                    override fun onResults(results: android.os.Bundle?) {
                        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        result = matches?.firstOrNull() ?: ""
                        latch.countDown()
                        recognizer.destroy()
                    }
                    override fun onPartialResults(partialResults: android.os.Bundle?) {}
                    override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
                })
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
                }
                recognizer.startListening(intent)
            } catch (e: Exception) {
                latch.countDown()
            }
        }
        latch.await(15, java.util.concurrent.TimeUnit.SECONDS)
        return result
    }

    @JavascriptInterface
    fun pickFile(): String {
        activity.runOnUiThread {
            activity.openFilePicker()
        }
        return ""
    }

    @JavascriptInterface
    fun saveFile(name: String, data: String): String {
        return try {
            val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            val file = File(dir, name)
            file.writeText(data)
            file.absolutePath
        } catch (e: Exception) { "" }
    }

    @JavascriptInterface
    fun readFile(path: String): String {
        return try {
            File(path).readText()
        } catch (e: Exception) { "" }
    }

    @JavascriptInterface
    fun kvGet(key: String): String {
        val prefs = activity.getSharedPreferences("skytron_kv", Context.MODE_PRIVATE)
        return prefs.getString(key, "") ?: ""
    }

    @JavascriptInterface
    fun kvSet(key: String, value: String) {
        activity.getSharedPreferences("skytron_kv", Context.MODE_PRIVATE)
            .edit().putString(key, value).apply()
    }

    @JavascriptInterface
    fun kvDel(key: String) {
        activity.getSharedPreferences("skytron_kv", Context.MODE_PRIVATE)
            .edit().remove(key).apply()
    }

    @JavascriptInterface
    fun getBat(): String {
        return try {
            val bm = activity.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).toString()
        } catch (e: Exception) { "-1" }
    }

    @JavascriptInterface
    fun getNet(): String {
        return try {
            val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
            when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            }
        } catch (e: Exception) { "unknown" }
    }

    @JavascriptInterface
    fun getVer(): String {
        return try {
            val pInfo = activity.packageManager.getPackageInfo(activity.packageName, 0)
            pInfo.versionName ?: "unknown"
        } catch (e: Exception) { "unknown" }
    }

    @JavascriptInterface
    fun vibrate(duration: Int) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vm.defaultVibrator.vibrate(VibrationEffect.createOneShot(duration.toLong(), VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                val v = activity.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                v.vibrate(VibrationEffect.createOneShot(duration.toLong(), VibrationEffect.DEFAULT_AMPLITUDE))
            }
        } catch (_: Exception) {}
    }

    @JavascriptInterface
    fun keepAwake(enable: Boolean) {
        try {
            activity.window.attributes = activity.window.attributes.apply {
                if (enable) {
                    flags = flags or android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                } else {
                    flags = flags and android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON.inv()
                }
            }
        } catch (_: Exception) {}
    }

    @JavascriptInterface
    fun setClip(text: String) {
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("skytron", text))
    }

    @JavascriptInterface
    fun getClip(): String {
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        return cm.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
    }

    @JavascriptInterface
    fun syncNow(): String {
        return try {
            val pending = db.syncDao().getPendingCount().toString()
            """{"pending":$pending}"""
        } catch (e: Exception) { """{"pending":0}""" }
    }

    private var tts: TextToSpeech? = null

    @JavascriptInterface
    fun speak(text: String) {
        try {
            if (tts == null) {
                tts = TextToSpeech(activity) { status ->
                    if (status == TextToSpeech.SUCCESS) {
                        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, UUID.randomUUID().toString())
                    }
                }
            } else {
                tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, UUID.randomUUID().toString())
            }
        } catch (_: Exception) {}
    }

    fun cleanup() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }

    @JavascriptInterface
    fun notify(title: String, body: String) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    activity.runOnUiThread {
                        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
                    }
                    return
                }
            }
            val id = System.currentTimeMillis().toInt()
            val notification = NotificationCompat.Builder(activity, SkytronApp.CHANNEL_ALERTS)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .build()
            NotificationManagerCompat.from(activity).notify(id, notification)
        } catch (_: Exception) {}
    }

    @JavascriptInterface
    fun dbGet(table: String, key: String): String {
        return try {
            val dao = db.appDao()
            dao.get(table, key) ?: ""
        } catch (e: Exception) { "" }
    }

    @JavascriptInterface
    fun dbSet(table: String, key: String, value: String) {
        scope.launch {
            try {
                db.appDao().put(KVEntry(table, key, value))
            } catch (e: Exception) {
                // Ignore
            }
        }
    }

    @JavascriptInterface
    fun dbDel(table: String, key: String) {
        scope.launch {
            try {
                db.appDao().delete(table, key)
            } catch (e: Exception) {
                // Ignore
            }
        }
    }

    @JavascriptInterface
    fun dbClear(table: String) {
        scope.launch {
            try {
                db.appDao().clearTable(table)
            } catch (e: Exception) {
                // Ignore
            }
        }
    }

    @JavascriptInterface
    fun syncEnq(action: String, type: String, key: String, value: String): String {
        val id = UUID.randomUUID().toString()
        scope.launch {
            try {
                db.syncDao().insert(SyncItem(id, action, type, key, value, "pending", System.currentTimeMillis()))
            } catch (e: Exception) {
                // Ignore
            }
        }
        return id
    }

    @JavascriptInterface
    fun syncStat(): String {
        return try {
            val pending = db.syncDao().getPendingCount()
            val failed = db.syncDao().getFailedCount()
            """{"pending":$pending,"failed":$failed}"""
        } catch (e: Exception) { """{"pending":0,"failed":0}""" }
    }
}
