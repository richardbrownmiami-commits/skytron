package com.skytron.app.db

import androidx.room.*

@Entity(tableName = "sync_queue")
data class SyncItem(
    @PrimaryKey val id: String,
    val action: String,
    val type: String,
    val key: String,
    val value: String,
    val status: String,
    val created_at: Long
)

@Dao
interface SyncDao {
    @Query("SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC")
    fun getPending(): List<SyncItem>

    @Query("SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'")
    fun getPendingCount(): Int

    @Query("SELECT COUNT(*) FROM sync_queue WHERE status = 'failed'")
    fun getFailedCount(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insert(item: SyncItem)

    @Query("UPDATE sync_queue SET status = :status WHERE id = :id")
    fun updateStatus(id: String, status: String)

    @Query("DELETE FROM sync_queue WHERE id = :id")
    fun delete(id: String)

    @Query("DELETE FROM sync_queue WHERE status != 'pending'")
    fun cleanProcessed()
}
