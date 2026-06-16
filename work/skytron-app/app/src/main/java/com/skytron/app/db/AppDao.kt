package com.skytron.app.db

import androidx.room.*

@Entity(tableName = "kv_store", primaryKeys = ["table_name", "key"])
data class KVEntry(
    @ColumnInfo(name = "table_name") val tableName: String,
    @ColumnInfo(name = "key") val key: String,
    @ColumnInfo(name = "value") val value: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long = System.currentTimeMillis()
)

@Dao
interface AppDao {
    @Query("SELECT value FROM kv_store WHERE table_name = :table AND `key` = :key")
    fun get(table: String, key: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun put(entry: KVEntry)

    @Query("DELETE FROM kv_store WHERE table_name = :table AND `key` = :key")
    fun delete(table: String, key: String)

    @Query("DELETE FROM kv_store WHERE table_name = :table")
    fun clearTable(table: String)

    @Query("SELECT * FROM kv_store WHERE table_name = :table")
    fun getAll(table: String): List<KVEntry>
}
