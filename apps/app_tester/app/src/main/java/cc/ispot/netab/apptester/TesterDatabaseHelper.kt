package cc.ispot.netab.apptester

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Small SQLite helper used by `app_tester`.
 *
 * It intentionally stores both Android-local coord state and a minimal steng
 * playground schema in one database so restart/restore behavior is easy to
 * verify from the phone UI.
 */
class TesterDatabaseHelper(context: Context) :
    SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
      CREATE TABLE IF NOT EXISTS probe_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL
      )
            """.trimIndent()
        )
        db.execSQL(
            """
      CREATE TABLE IF NOT EXISTS coord_state (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL
      )
            """.trimIndent()
        )
        db.execSQL(
            """
      CREATE TABLE IF NOT EXISTS steng_tables (
        table_id INTEGER PRIMARY KEY AUTOINCREMENT,
        app TEXT NOT NULL,
        db TEXT NOT NULL,
        table_name TEXT NOT NULL,
        type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        UNIQUE(app, db, table_name)
      )
            """.trimIndent()
        )
        db.execSQL(
            """
      CREATE TABLE IF NOT EXISTS steng_docs (
        table_id INTEGER NOT NULL,
        doc_id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(table_id, doc_id)
      )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS probe_events")
        db.execSQL("DROP TABLE IF EXISTS coord_state")
        db.execSQL("DROP TABLE IF EXISTS steng_tables")
        db.execSQL("DROP TABLE IF EXISTS steng_docs")
        onCreate(db)
    }

    /**
     * Returns JSON state.
     * @param key Key.
     */
    fun getJsonState(key: String): String? = readableDatabase.rawQuery(
        "SELECT json FROM coord_state WHERE key = ?",
        arrayOf(key)
    ).useSingleString()

    /**
     * Handles put JSON state.
     * @param key Key.
     * @param json JSON.
     */
    fun putJsonState(key: String, json: String) {
        val values = ContentValues().apply {
            put("key", key)
            put("json", json)
        }
        writableDatabase.insertWithOnConflict(
            "coord_state",
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    /**
     * Removes state.
     * @param key Key.
     */
    fun deleteState(key: String) {
        writableDatabase.delete("coord_state", "key = ?", arrayOf(key))
    }

    /**
     * Ensures steng table.
     * @param app Application name.
     * @param db Database name.
     * @param tableName Table name.
     * @param type Type value to process.
     * @param configJson Configuration JSON.
     */
    fun ensureStengTable(
        app: String,
        db: String,
        tableName: String,
        type: String,
        configJson: String
    ): Long {
        val existing = readableDatabase.rawQuery(
            "SELECT table_id FROM steng_tables WHERE app = ? AND db = ? AND table_name = ?",
            arrayOf(app, db, tableName)
        ).useSingleLong()
        if (existing != null) {
            writableDatabase.execSQL(
                "UPDATE steng_tables SET type = ?, config_json = ? WHERE table_id = ?",
                arrayOf(type, configJson, existing)
            )
            return existing
        }
        val values = ContentValues().apply {
            put("app", app)
            put("db", db)
            put("table_name", tableName)
            put("type", type)
            put("config_json", configJson)
        }
        return writableDatabase.insertOrThrow("steng_tables", null, values)
    }

    /**
     * Handles find steng table.
     * @param app Application name.
     * @param db Database name.
     * @param tableName Table name.
     */
    fun findStengTable(app: String, db: String, tableName: String): Long? =
        readableDatabase.rawQuery(
            "SELECT table_id FROM steng_tables WHERE app = ? AND db = ? AND table_name = ?",
            arrayOf(app, db, tableName)
        ).useSingleLong()

    /**
     * Adds or replace steng doc.
     * @param tableId Table identifier.
     * @param docId Doc id.
     * @param valueJson Value JSON.
     * @param updatedAtMs Timestamp in milliseconds.
     * @param deleted Deleted.
     */
    fun addOrReplaceStengDoc(
        tableId: Long,
        docId: String,
        valueJson: String,
        updatedAtMs: Long,
        deleted: Boolean = false
    ) {
        val values = ContentValues().apply {
            put("table_id", tableId)
            put("doc_id", docId)
            put("value_json", valueJson)
            put("updated_at_ms", updatedAtMs)
            put("deleted", if (deleted) 1 else 0)
        }
        writableDatabase.insertWithOnConflict(
            "steng_docs",
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    /**
     * Lists steng docs.
     * @param tableId Table identifier.
     */
    fun listStengDocs(tableId: Long): List<Pair<String, String>> {
        val result = mutableListOf<Pair<String, String>>()
        readableDatabase.rawQuery(
            "SELECT doc_id, value_json FROM steng_docs WHERE table_id = ? AND deleted = 0 ORDER BY updated_at_ms DESC, doc_id ASC",
            arrayOf(tableId.toString())
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result += cursor.getString(0) to cursor.getString(1)
            }
        }
        return result
    }

    companion object {
        const val DB_NAME = "app_tester.sqlite"
        const val DB_VERSION = 2
    }
}

/** Cursor helper that returns the first string column or `null` when empty. */
private fun Cursor.useSingleString(): String? {
    use {
        return if (it.moveToFirst()) it.getString(0) else null
    }
}

/** Cursor helper that returns the first long column or `null` when empty. */
private fun Cursor.useSingleLong(): Long? {
    use {
        return if (it.moveToFirst()) it.getLong(0) else null
    }
}
