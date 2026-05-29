//! Thin safe wrapper around rusqlite + sqlite-vec, isolating the one
//! `unsafe` block needed to register sqlite-vec's loadable extension.
//!
//! The rest of the workspace (in particular the `server` crate) forbids
//! unsafe code; concentrating the FFI surface here keeps that policy
//! intact and gives RAG store callers a small, intention-revealing API
//! (`Database::open`, `Database::ensure_vec_table`, …).

use std::path::Path;
use std::sync::Once;

use rusqlite::{params, Connection};
use zerocopy::AsBytes;

/// Loads the sqlite-vec extension exactly once for the lifetime of the
/// process. Subsequent `Database::open` calls inherit it via the
/// connection's autoload hook. Idempotent and thread-safe.
fn init_once() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // SAFETY: registering an FFI extension entry point on the global
        // SQLite registry. The cast matches what sqlite-vec's docs show
        // and what `rag-poc` validated end-to-end. This is the one place
        // unsafe is required by the extension model.
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

/// Owned connection to a single sqlite-vec-enabled database file.
pub struct Database {
    conn: Connection,
}

impl Database {
    /// Open or create a database file. The parent directory must already
    /// exist — callers (e.g. the RAG library manager) are responsible for
    /// `mkdir -p` semantics so we can keep this primitive thin.
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        init_once();
        let conn = Connection::open(path)?;
        Ok(Self { conn })
    }

    /// In-memory database — handy for tests and ephemeral retrieval.
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        init_once();
        Ok(Self {
            conn: Connection::open_in_memory()?,
        })
    }

    /// Report sqlite-vec's version. Used as a smoke check on first use.
    pub fn vec_version(&self) -> rusqlite::Result<String> {
        self.conn
            .query_row("SELECT vec_version()", [], |row| row.get(0))
    }

    /// Ensure a vec0 virtual table exists for `dim`-dimensional vectors.
    /// Idempotent — calling repeatedly on the same db is a no-op.
    pub fn ensure_vec_table(&self, table: &str, dim: usize) -> rusqlite::Result<()> {
        // Inlining `table` into the DDL is unavoidable for CREATE TABLE
        // (rusqlite can't bind identifiers), so we validate it strictly
        // first to keep this injection-free.
        require_ident(table)?;
        let sql = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS {table} USING vec0(embedding float[{dim}])"
        );
        self.conn.execute(&sql, [])?;
        Ok(())
    }

    /// Ensure a companion regular table to hold chunk metadata + content.
    /// The matching `rowid` is what ties an entry here to its embedding
    /// in the vec0 table.
    pub fn ensure_chunks_table(&self, table: &str) -> rusqlite::Result<()> {
        require_ident(table)?;
        let sql = format!(
            "CREATE TABLE IF NOT EXISTS {table} (
                rowid INTEGER PRIMARY KEY,
                source TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )"
        );
        self.conn.execute(&sql, [])?;
        Ok(())
    }

    /// Insert a single chunk + its vector. Returns the rowid assigned by
    /// SQLite. Pairs the metadata in `chunks_table` with the embedding in
    /// `vec_table` under the same rowid so retrieval can join cheaply.
    pub fn insert_chunk(
        &self,
        chunks_table: &str,
        vec_table: &str,
        source: &str,
        content: &str,
        embedding: &[f32],
        created_at: i64,
    ) -> rusqlite::Result<i64> {
        require_ident(chunks_table)?;
        require_ident(vec_table)?;
        let row_sql = format!(
            "INSERT INTO {chunks_table} (source, content, created_at) VALUES (?1, ?2, ?3)"
        );
        self.conn.execute(&row_sql, params![source, content, created_at])?;
        let rowid = self.conn.last_insert_rowid();
        let vec_sql = format!("INSERT INTO {vec_table} (rowid, embedding) VALUES (?1, ?2)");
        self.conn.execute(&vec_sql, params![rowid, embedding.as_bytes()])?;
        Ok(rowid)
    }

    /// k-NN search: returns `(rowid, source, content, distance)` for the
    /// `k` chunks closest to `query`. Joins vec0 distances against the
    /// chunks table so callers get human-readable results in one call.
    pub fn top_k(
        &self,
        chunks_table: &str,
        vec_table: &str,
        query: &[f32],
        k: usize,
    ) -> rusqlite::Result<Vec<RetrievedChunk>> {
        require_ident(chunks_table)?;
        require_ident(vec_table)?;
        // sqlite-vec demands `k = ?` (or LIMIT) on the vec0 side, but a
        // LIMIT on the outer joined query doesn't satisfy it. Use a
        // subquery so the LIMIT sits directly on the vec0 KNN scan, then
        // join the metadata in a wrapper.
        let sql = format!(
            "SELECT c.rowid, c.source, c.content, v.distance
             FROM (
                 SELECT rowid, distance
                 FROM {vec_table}
                 WHERE embedding MATCH ?1
                 ORDER BY distance
                 LIMIT ?2
             ) AS v
             JOIN {chunks_table} AS c ON c.rowid = v.rowid
             ORDER BY v.distance"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![query.as_bytes(), k as i64],
            |row| {
                Ok(RetrievedChunk {
                    rowid: row.get(0)?,
                    source: row.get(1)?,
                    content: row.get(2)?,
                    distance: row.get(3)?,
                })
            },
        )?;
        rows.collect()
    }

    /// Count chunks in `chunks_table` — fast `COUNT(*)` for the library
    /// summary UI.
    pub fn count_chunks(&self, chunks_table: &str) -> rusqlite::Result<u64> {
        require_ident(chunks_table)?;
        let sql = format!("SELECT COUNT(*) FROM {chunks_table}");
        let count: i64 = self.conn.query_row(&sql, [], |row| row.get(0))?;
        Ok(count.max(0) as u64)
    }

    /// Distinct source identifiers — gives the UI a "files in this
    /// library" view without scanning every chunk.
    pub fn distinct_sources(&self, chunks_table: &str) -> rusqlite::Result<Vec<String>> {
        require_ident(chunks_table)?;
        let sql = format!("SELECT DISTINCT source FROM {chunks_table} ORDER BY source");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    }
}

#[derive(Debug, Clone)]
pub struct RetrievedChunk {
    pub rowid: i64,
    pub source: String,
    pub content: String,
    pub distance: f32,
}

/// Reject anything that isn't a plain identifier — this is the only
/// defence against SQL injection for the table names we splice into DDL.
fn require_ident(name: &str) -> rusqlite::Result<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "invalid identifier `{name}`"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_small_vec() {
        let db = Database::open_in_memory().expect("open in memory");
        let version = db.vec_version().expect("version");
        assert!(version.starts_with('v'), "expected sqlite-vec version, got `{version}`");

        db.ensure_chunks_table("chunks").expect("chunks ddl");
        db.ensure_vec_table("vecs", 4).expect("vecs ddl");

        let id1 = db
            .insert_chunk("chunks", "vecs", "a.md", "hello world", &[1.0, 0.0, 0.0, 0.0], 1)
            .expect("insert 1");
        let id2 = db
            .insert_chunk("chunks", "vecs", "a.md", "goodbye world", &[0.9, 0.1, 0.0, 0.0], 2)
            .expect("insert 2");
        let id3 = db
            .insert_chunk("chunks", "vecs", "b.md", "different thing", &[0.0, 1.0, 0.0, 0.0], 3)
            .expect("insert 3");

        // Pull top-2 nearest to a probe close to entries 1 + 2 — should
        // be (1,2) in some order with much smaller distance than 3.
        let hits = db
            .top_k("chunks", "vecs", &[0.95, 0.05, 0.0, 0.0], 2)
            .expect("search");
        assert_eq!(hits.len(), 2);
        let returned_ids: Vec<i64> = hits.iter().map(|h| h.rowid).collect();
        assert!(returned_ids.contains(&id1) && returned_ids.contains(&id2));
        assert!(!returned_ids.contains(&id3));
        assert_eq!(hits[0].source, "a.md");

        assert_eq!(db.count_chunks("chunks").expect("count"), 3);
        let sources = db.distinct_sources("chunks").expect("sources");
        assert_eq!(sources, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[test]
    fn ddl_rejects_bad_identifiers() {
        let db = Database::open_in_memory().expect("open");
        let err = db
            .ensure_chunks_table("chunks; DROP TABLE x;")
            .expect_err("must reject injection");
        let msg = err.to_string();
        assert!(msg.contains("invalid identifier"), "got: {msg}");
    }

    #[test]
    fn idempotent_ddl() {
        let db = Database::open_in_memory().expect("open");
        db.ensure_chunks_table("chunks").expect("first");
        db.ensure_chunks_table("chunks").expect("second is no-op");
        db.ensure_vec_table("vecs", 4).expect("first");
        db.ensure_vec_table("vecs", 4).expect("second is no-op");
    }
}
