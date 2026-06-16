package com.skytron.app.worker

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.skytron.app.db.AppDatabase
import com.skytron.app.db.SyncItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class SyncWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            val db = AppDatabase.getInstance(applicationContext)
            val syncDao = db.syncDao()
            val pending = syncDao.getPending()

            if (pending.isEmpty()) return@withContext Result.success()

            for (item in pending) {
                try {
                    syncDao.updateStatus(item.id, "processing")
                    val success = processItem(item)
                    syncDao.updateStatus(item.id, if (success) "done" else "failed")
                } catch (e: Exception) {
                    syncDao.updateStatus(item.id, "failed")
                }
            }

            syncDao.cleanProcessed()
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    private fun processItem(item: SyncItem): Boolean {
        return try {
            val prefs = applicationContext.getSharedPreferences("skytron_prefs", Context.MODE_PRIVATE)
            val syncUrl = prefs.getString("sync_url", "") ?: ""

            if (syncUrl.isBlank()) {
                storeOffline(item)
                return true
            }

            val url = URL(syncUrl)
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 10000
            conn.readTimeout = 10000

            val body = JSONObject().apply {
                put("action", item.action)
                put("type", item.type)
                put("key", item.key)
                put("value", item.value)
                put("timestamp", item.created_at)
            }

            conn.outputStream.write(body.toString().toByteArray())
            val code = conn.responseCode
            conn.disconnect()
            code in 200..299
        } catch (e: Exception) {
            storeOffline(item)
            true
        }
    }

    private fun storeOffline(item: SyncItem) {
        try {
            val db = AppDatabase.getInstance(applicationContext)
            val jsonValue = JSONObject().apply {
                put("action", item.action)
                put("type", item.type)
                put("key", item.key)
                put("value", item.value)
                put("ts", item.created_at)
            }.toString()

            db.appDao().put(
                com.skytron.app.db.KVEntry(
                    tableName = "offline_sync",
                    key = item.id,
                    value = jsonValue
                )
            )
        } catch (_: Exception) {}
    }
}
