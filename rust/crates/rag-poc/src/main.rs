//! POC: verify sqlite-vec works in Rust for the RAG plan.
//!
//! The test we run:
//!   1. Open an in-memory SQLite, load sqlite-vec extension
//!   2. Create a `vec0` virtual table with 4-dim float vectors
//!   3. Insert 5 dummy vectors with labels
//!   4. Query the 3 nearest neighbours of a probe vector
//!   5. Print the rowids + distances and exit 0
//!
//! No integration with the server crate. The point is to learn the API
//! shape, confirm the macOS build works, and get a feel for whether this
//! is the right primitive for the real RAG store.

use rusqlite::{ffi::sqlite3_auto_extension, params, Connection};
use sqlite_vec::sqlite3_vec_init;
use zerocopy::AsBytes;

fn main() -> rusqlite::Result<()> {
    // The extension auto-registers globally for every connection opened
    // after this call. One-shot in a process — safe to call here at the
    // top of main().
    unsafe {
        sqlite3_auto_extension(Some(std::mem::transmute(sqlite3_vec_init as *const ())));
    }

    let conn = Connection::open_in_memory()?;

    // Quick version check — confirms the extension actually loaded and
    // matches what the docs say (vec0 module is what we use below).
    let vec_version: String = conn.query_row("SELECT vec_version()", [], |row| row.get(0))?;
    println!("sqlite-vec version: {vec_version}");

    // `vec0` is the virtual-table module sqlite-vec ships. Embedding
    // column is `embedding float[4]` — 4-dim just for the POC.
    conn.execute(
        "CREATE VIRTUAL TABLE chunks USING vec0(embedding float[4])",
        [],
    )?;

    // Five chunks with hand-picked vectors so the nearest-neighbour
    // answer is obvious — chunk 1 is the closest to the probe below.
    let entries: &[(i64, [f32; 4])] = &[
        (1, [1.0, 0.0, 0.0, 0.0]),
        (2, [0.9, 0.1, 0.0, 0.0]),
        (3, [0.0, 1.0, 0.0, 0.0]),
        (4, [0.0, 0.0, 1.0, 0.0]),
        (5, [0.0, 0.0, 0.0, 1.0]),
    ];
    for (id, vec) in entries {
        // vec0 takes the embedding column as a raw little-endian byte
        // blob. `zerocopy::IntoBytes` gives us a safe reinterpret of the
        // f32 array — same encoding sqlite-vec expects.
        conn.execute(
            "INSERT INTO chunks (rowid, embedding) VALUES (?1, ?2)",
            params![id, vec.as_bytes()],
        )?;
    }

    // Query top-3 nearest neighbours of a probe close to entry #1.
    // sqlite-vec uses MATCH on the embedding column with `k=N`.
    let probe: [f32; 4] = [0.95, 0.05, 0.0, 0.0];
    let mut stmt = conn.prepare(
        "SELECT rowid, distance
         FROM chunks
         WHERE embedding MATCH ?1
         ORDER BY distance
         LIMIT 3",
    )?;
    let rows = stmt.query_map(params![probe.as_bytes()], |row| {
        let id: i64 = row.get(0)?;
        let dist: f32 = row.get(1)?;
        Ok((id, dist))
    })?;

    println!("top-3 nearest to [0.95, 0.05, 0.0, 0.0]:");
    for row in rows {
        let (id, dist) = row?;
        println!("  rowid={id}  distance={dist:.6}");
    }

    // Realistic-scale benchmark: 1536-dim (OpenAI embedding-3-small),
    // 10k chunks, single top-5 query. This is the size we'd hit a few
    // thousand-document personal library at; if it's measurable but not
    // painful we're fine for the first cut.
    bench_realistic(&conn)?;

    Ok(())
}

fn bench_realistic(conn: &Connection) -> rusqlite::Result<()> {
    use std::time::Instant;
    const DIM: usize = 1536;
    const N: usize = 10_000;
    conn.execute(
        "CREATE VIRTUAL TABLE big USING vec0(embedding float[1536])",
        [],
    )?;

    let mut stmt = conn.prepare("INSERT INTO big (rowid, embedding) VALUES (?1, ?2)")?;
    let t0 = Instant::now();
    // Deterministic pseudo-random fill so distances aren't all identical.
    let mut buf: Vec<f32> = vec![0.0; DIM];
    for i in 0..N {
        for (j, slot) in buf.iter_mut().enumerate() {
            *slot = ((i.wrapping_mul(31).wrapping_add(j)) as f32 % 7.0) / 7.0;
        }
        stmt.execute(params![i as i64, buf.as_bytes()])?;
    }
    let ingest_ms = t0.elapsed().as_millis();
    println!("\n--- 1536-dim × {N} chunks ---");
    println!("ingest:   {ingest_ms} ms ({:.1} chunks/sec)", N as f64 * 1000.0 / ingest_ms as f64);

    // Probe vector — just use the first chunk's pattern so we know
    // there's a clear match.
    for (j, slot) in buf.iter_mut().enumerate() {
        *slot = ((j) as f32 % 7.0) / 7.0;
    }
    let t1 = Instant::now();
    let mut q = conn.prepare(
        "SELECT rowid, distance FROM big WHERE embedding MATCH ?1 ORDER BY distance LIMIT 5",
    )?;
    let hits: Vec<(i64, f32)> = q
        .query_map(params![buf.as_bytes()], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let query_ms = t1.elapsed().as_millis();
    println!("top-5:    {query_ms} ms");
    for (id, d) in hits {
        println!("  rowid={id:6}  d={d:.4}");
    }
    Ok(())
}
