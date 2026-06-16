package com.skytron.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.skytron.app.db.AppDatabase
import com.skytron.app.worker.SyncWorker
import java.util.concurrent.TimeUnit

class SkytronApp : Application() {

    lateinit var database: AppDatabase
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        database = AppDatabase.getInstance(this)
        createNotificationChannels()
        schedulePeriodicSync()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)

            val syncChannel = NotificationChannel(
                CHANNEL_SYNC, "Sync",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Background sync status"
                setShowBadge(false)
            }

            val alertChannel = NotificationChannel(
                CHANNEL_ALERTS, "Alerts",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Skytron alerts and reminders"
            }

            manager.createNotificationChannels(listOf(syncChannel, alertChannel))
        }
    }

    private fun schedulePeriodicSync() {
        val syncRequest = PeriodicWorkRequestBuilder<SyncWorker>(
            15, TimeUnit.MINUTES
        ).build()

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "skytron_sync",
            ExistingPeriodicWorkPolicy.KEEP,
            syncRequest
        )
    }

    companion object {
        const val CHANNEL_SYNC = "sync_channel"
        const val CHANNEL_ALERTS = "alerts_channel"

        lateinit var instance: SkytronApp
            private set
    }
}
