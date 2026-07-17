//! Build script that tells cargo to re-run/recompile whenever any of the
//! files embedded via `include_str!` change.
//!
//! By default, cargo's fingerprinting for whether a crate needs to be
//! recompiled only watches files under the crate's own source tree
//! (`src/**`, `Cargo.toml`, etc). The daemon JS bundles and the dev-browser
//! skill doc are embedded via `include_str!` with paths that reach *outside*
//! this crate (`../../daemon/dist/*`, `../skills/dev-browser/SKILL.md`), so
//! cargo does not notice when they change on disk and can silently keep
//! serving a stale compiled-in copy (e.g. after `pnpm bundle` regenerates
//! `daemon/dist/daemon.bundle.mjs` but before a fresh `cargo build --release`).
//!
//! Emitting `cargo:rerun-if-changed` for each embedded file closes that gap:
//! cargo will treat the crate as dirty and recompile whenever any of these
//! files' mtimes change.

fn main() {
    println!("cargo:rerun-if-changed=../daemon/dist/daemon.bundle.mjs");
    println!("cargo:rerun-if-changed=../daemon/dist/sandbox-client.js");
    println!("cargo:rerun-if-changed=../skills/dev-browser/SKILL.md");
    println!("cargo:rerun-if-changed=llm-guide.txt");
}
