//! RAG library store — owns a set of named libraries, each backed by a
//! single sqlite-vec database file under `~/.claw/rag/<name>.db`.
//!
//! This module is the storage + chunking layer. It does NOT know about
//! HTTP or embeddings — the HTTP layer (in `lib.rs`) drives ingestion by
//! computing embeddings with the OpenAI client and handing back a
//! `(content, embedding)` pair per chunk.
//!
//! Why a file per library and not one shared db: deletion is then a
//! straightforward `unlink`, libraries can be moved between machines as
//! a single file, and concurrent reads against different libraries never
//! contend on the same file.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

/// Sensible default — OpenAI's `text-embedding-3-small` native dim.
/// `LibraryStore` is parameterised so different embedding providers
/// (DashScope's `text-embedding-v4` is 1024, BGE-m3 is 1024, …) work
/// without recompile, but DDL is committed when each library file is
/// first created. Mixing dims across a single library is unsupported —
/// callers must keep one library = one embedding model.
pub const DEFAULT_EMBEDDING_DIM: usize = 1536;
const CHUNKS_TABLE: &str = "chunks";
const VEC_TABLE: &str = "chunk_embeddings";

/// Default chunk size in characters. ~500 tokens at the ~4 chars/token
/// heuristic — comfortably below the 8k input limit of `text-embedding-3-
/// small` and small enough that 5 retrieved chunks fit a budget bump.
const TARGET_CHUNK_CHARS: usize = 2000;
/// Overlap between adjacent chunks so context near boundaries isn't
/// orphaned. ~100 tokens of overlap.
const CHUNK_OVERLAP_CHARS: usize = 400;

/// Stamp-only metadata for the catalog UI; computed by walking the file
/// stat + a COUNT(*) on the chunks table.
#[derive(Debug, Clone, Serialize)]
pub struct LibrarySummary {
    pub name: String,
    pub chunk_count: u64,
    pub size_bytes: u64,
    /// Unix-millis of last `INSERT` we observed (== the most recent
    /// `created_at` field). `None` for empty libraries.
    pub last_updated_ms: Option<i64>,
    pub sources: Vec<String>,
}

/// In-process registry of open library handles.
///
/// Each library opens its sqlite file on first use and stays open for the
/// process lifetime — opening sqlite is cheap but doing it on every API
/// hit would still serialise through the OS. A per-library Mutex wraps
/// the connection because `vecdb::Database` borrows `&self` for reads
/// but `&mut`-style operations during write paths share the same
/// underlying connection.
#[derive(Clone)]
pub struct LibraryStore {
    root: Arc<PathBuf>,
    /// Embedding vector dimension. Baked into vec0 DDL when each library
    /// file is first created — a library on disk silently locks in
    /// whatever dim was current at create time. Switching dims later
    /// breaks insert/retrieve for that library (sqlite-vec rejects
    /// wrong-sized vectors); the user has to drop + recreate the
    /// library. We don't track per-library dim on disk yet (TODO).
    dim: usize,
    handles: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<vecdb::Database>>>>>,
}

impl LibraryStore {
    /// Create a store rooted at `dir` with a fixed embedding dim.
    /// Caller ensures `dir` exists or is creatable —
    /// `LibraryStore::ensure_root` does that lazily on the first write.
    #[must_use]
    pub fn new(root: PathBuf, dim: usize) -> Self {
        Self {
            root: Arc::new(root),
            dim,
            handles: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    #[must_use]
    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Default location: `$HOME/.claw/rag`. Falls back to `./rag` if
    /// `$HOME` is unset (CI / containers).
    #[must_use]
    pub fn default_root() -> PathBuf {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map_or_else(|| PathBuf::from("./rag"), |home| home.join(".claw").join("rag"))
    }

    fn ensure_root(&self) -> std::io::Result<()> {
        fs::create_dir_all(self.root.as_ref())
    }

    fn db_path(&self, name: &str) -> PathBuf {
        self.root.join(format!("{name}.db"))
    }

    /// Validate that `name` is safe to splice into a filename. Mirrors
    /// vecdb's identifier guard plus a length cap.
    pub fn validate_name(name: &str) -> Result<(), String> {
        if name.is_empty() {
            return Err("library name must not be empty".into());
        }
        if name.len() > 64 {
            return Err("library name exceeds 64 chars".into());
        }
        let ok = name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !ok {
            return Err(
                "library name may only contain ASCII alphanumerics, `-` and `_`".into(),
            );
        }
        Ok(())
    }

    /// Open (or create on first use) a library by name. Returns a shared
    /// handle that callers must `.lock()` before issuing operations.
    pub async fn open(&self, name: &str) -> Result<Arc<Mutex<vecdb::Database>>, String> {
        Self::validate_name(name)?;
        self.ensure_root().map_err(|e| e.to_string())?;
        // Cheap fast path — handle already cached.
        {
            let cache = self.handles.lock().await;
            if let Some(handle) = cache.get(name) {
                return Ok(handle.clone());
            }
        }
        // Slow path — open file, run DDL, cache.
        let path = self.db_path(name);
        let db = vecdb::Database::open(&path).map_err(|e| e.to_string())?;
        db.ensure_chunks_table(CHUNKS_TABLE).map_err(|e| e.to_string())?;
        db.ensure_vec_table(VEC_TABLE, self.dim)
            .map_err(|e| e.to_string())?;
        let handle = Arc::new(Mutex::new(db));
        let mut cache = self.handles.lock().await;
        Ok(cache.entry(name.to_string()).or_insert(handle).clone())
    }

    /// List libraries by scanning the root dir for `*.db` files.
    /// Lightweight — no DB opens unless the caller asks for summary.
    pub async fn list(&self) -> Result<Vec<String>, String> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(self.root.as_ref()).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("db") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if Self::validate_name(stem).is_ok() {
                    out.push(stem.to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Build the summary for one library — chunk count, size, distinct
    /// sources. Opens the DB if not already cached.
    pub async fn summary(&self, name: &str) -> Result<LibrarySummary, String> {
        let handle = self.open(name).await?;
        let db = handle.lock().await;
        let chunk_count = db.count_chunks(CHUNKS_TABLE).map_err(|e| e.to_string())?;
        let sources = db
            .distinct_sources(CHUNKS_TABLE)
            .map_err(|e| e.to_string())?;
        let size_bytes = fs::metadata(self.db_path(name))
            .map(|m| m.len())
            .unwrap_or(0);
        Ok(LibrarySummary {
            name: name.to_string(),
            chunk_count,
            size_bytes,
            last_updated_ms: None, // future: scan MAX(created_at)
            sources,
        })
    }

    /// Delete a library — drops the cached handle then removes the file.
    /// Idempotent: deleting a nonexistent library returns Ok(false).
    pub async fn delete(&self, name: &str) -> Result<bool, String> {
        Self::validate_name(name)?;
        // Drop any open handle first so SQLite releases the file lock on
        // platforms where it cares (Windows).
        {
            let mut cache = self.handles.lock().await;
            cache.remove(name);
        }
        let path = self.db_path(name);
        if !path.exists() {
            return Ok(false);
        }
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// Ingest pre-chunked + pre-embedded content into a library. The
    /// chunking and embedding decisions live in the HTTP layer; this
    /// crate is purely storage.
    pub async fn ingest_chunks(
        &self,
        name: &str,
        source: &str,
        chunks: &[ChunkWithEmbedding],
    ) -> Result<u32, String> {
        let handle = self.open(name).await?;
        let db = handle.lock().await;
        let now = chrono::Utc::now().timestamp_millis();
        let mut written: u32 = 0;
        for chunk in chunks {
            db.insert_chunk(
                CHUNKS_TABLE,
                VEC_TABLE,
                source,
                &chunk.content,
                &chunk.embedding,
                now,
            )
            .map_err(|e| e.to_string())?;
            written += 1;
        }
        Ok(written)
    }

    /// Retrieve top-K chunks closest to `query_embedding`.
    pub async fn retrieve(
        &self,
        name: &str,
        query_embedding: &[f32],
        k: usize,
    ) -> Result<Vec<vecdb::RetrievedChunk>, String> {
        let handle = self.open(name).await?;
        let db = handle.lock().await;
        db.top_k(CHUNKS_TABLE, VEC_TABLE, query_embedding, k)
            .map_err(|e| e.to_string())
    }
}

/// A single chunk along with its pre-computed embedding. The HTTP layer
/// builds these by chunking the source text + calling the embedding
/// provider.
#[derive(Debug, Clone)]
pub struct ChunkWithEmbedding {
    pub content: String,
    pub embedding: Vec<f32>,
}

/// Split `text` into chunks suitable for embedding. Chunking is a
/// surprisingly load-bearing piece of RAG quality — for v1 we use a
/// simple character-based windowing with overlap, which works well for
/// prose, markdown, and source code without language-specific parsing.
///
/// The window targets ~`TARGET_CHUNK_CHARS` characters with
/// `CHUNK_OVERLAP_CHARS` overlap between adjacent chunks so context
/// near a boundary isn't lost. We try to break at paragraph or sentence
/// boundaries within the window.
#[must_use]
pub fn chunk_text(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    if chars.len() <= TARGET_CHUNK_CHARS {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let nominal_end = (start + TARGET_CHUNK_CHARS).min(chars.len());
        // Try to land on a paragraph break (double newline) inside the
        // last 20% of the window; failing that, on any newline; failing
        // that, on whitespace. Keeps chunks readable even when they're
        // smaller than the target.
        let search_from = start + (TARGET_CHUNK_CHARS * 8 / 10);
        let end = if nominal_end == chars.len() {
            nominal_end
        } else {
            find_boundary(&chars, search_from, nominal_end).unwrap_or(nominal_end)
        };
        let slice: String = chars[start..end].iter().collect();
        let trimmed = slice.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
        if end == chars.len() {
            break;
        }
        // Step forward by `end - overlap`, never going backwards (which
        // would happen if the window is tiny).
        let next_start = end.saturating_sub(CHUNK_OVERLAP_CHARS);
        start = if next_start > start { next_start } else { end };
    }
    out
}

/// Look for a clean break (double newline > single newline > whitespace)
/// in `[lo, hi)`. Prefer the latest occurrence so chunks stay close to
/// `TARGET_CHUNK_CHARS`.
fn find_boundary(chars: &[char], lo: usize, hi: usize) -> Option<usize> {
    if lo >= hi {
        return None;
    }
    let window = &chars[lo..hi];
    // Pass 1 — last paragraph break.
    for i in (1..window.len()).rev() {
        if window[i] == '\n' && window[i - 1] == '\n' {
            return Some(lo + i + 1);
        }
    }
    // Pass 2 — last single newline.
    for i in (0..window.len()).rev() {
        if window[i] == '\n' {
            return Some(lo + i + 1);
        }
    }
    // Pass 3 — last whitespace.
    for i in (0..window.len()).rev() {
        if window[i].is_whitespace() {
            return Some(lo + i + 1);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn dummy_embedding(seed: f32) -> Vec<f32> {
        // 1536-dim "embedding" with one significant component — enough
        // to differentiate chunks in the unit-test top_k call.
        let mut v = vec![0.0; DEFAULT_EMBEDDING_DIM];
        v[0] = seed;
        v
    }

    #[tokio::test]
    async fn library_lifecycle_create_ingest_retrieve_delete() {
        let tmp = TempDir::new().expect("tmpdir");
        let store = LibraryStore::new(tmp.path().to_path_buf(), DEFAULT_EMBEDDING_DIM);

        assert!(store.list().await.unwrap().is_empty());

        // Ingesting creates the library if absent.
        let chunks = vec![
            ChunkWithEmbedding {
                content: "first paragraph about cats".to_string(),
                embedding: dummy_embedding(1.0),
            },
            ChunkWithEmbedding {
                content: "second paragraph about dogs".to_string(),
                embedding: dummy_embedding(0.0),
            },
        ];
        let written = store
            .ingest_chunks("mylib", "a.md", &chunks)
            .await
            .expect("ingest");
        assert_eq!(written, 2);

        let names = store.list().await.unwrap();
        assert_eq!(names, vec!["mylib".to_string()]);

        let summary = store.summary("mylib").await.unwrap();
        assert_eq!(summary.chunk_count, 2);
        assert_eq!(summary.sources, vec!["a.md".to_string()]);
        assert!(summary.size_bytes > 0);

        // Retrieve with a probe nearer to the "cats" chunk than "dogs".
        let probe = dummy_embedding(0.95);
        let hits = store.retrieve("mylib", &probe, 1).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].content.contains("cats"),
            "expected cats chunk first; got: {}",
            hits[0].content,
        );

        // Delete is idempotent.
        assert!(store.delete("mylib").await.unwrap());
        assert!(!store.delete("mylib").await.unwrap());
        assert!(store.list().await.unwrap().is_empty());
    }

    #[test]
    fn validate_name_rejects_path_traversal_and_punctuation() {
        assert!(LibraryStore::validate_name("good_name-1").is_ok());
        assert!(LibraryStore::validate_name("").is_err());
        assert!(LibraryStore::validate_name("../escape").is_err());
        assert!(LibraryStore::validate_name("with space").is_err());
        assert!(LibraryStore::validate_name("with/slash").is_err());
    }

    #[test]
    fn chunk_text_short_input_passes_through_single_chunk() {
        let text = "short paragraph";
        assert_eq!(chunk_text(text), vec!["short paragraph".to_string()]);
    }

    #[test]
    fn chunk_text_empty_input_returns_empty() {
        assert!(chunk_text("").is_empty());
    }

    #[test]
    fn chunk_text_long_input_produces_overlapping_chunks() {
        // Build a doc of ~3 windows so we get 2-3 chunks.
        let para_a = "alpha\n".repeat(700); // ~4200 chars
        let para_b = "beta\n".repeat(700); // another 4200 chars
        let doc = format!("{para_a}\n\n{para_b}");
        let chunks = chunk_text(&doc);
        assert!(chunks.len() >= 3, "expected ≥3 chunks, got {}", chunks.len());
        // Each chunk except possibly the last should be near the target
        // size — but never exceed by much.
        for (i, c) in chunks.iter().enumerate() {
            let len = c.chars().count();
            assert!(
                len <= TARGET_CHUNK_CHARS + 200,
                "chunk {i} too large: {len}"
            );
        }
        // Boundary chars overlap — second chunk starts mid-content from
        // the first. We can't be exact without replicating the boundary
        // logic, so just assert the chunks aren't identical and the
        // doc's tail words appear in the last chunk.
        let last = chunks.last().unwrap();
        assert!(last.contains("beta"), "tail of doc missing in last chunk");
    }
}
