//! Centralised error type. All Tauri commands return `Result<T, Error>` so
//! the JS side gets predictable error shapes.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("audio device error: {0}")]
    Device(String),

    #[error("audio stream error: {0}")]
    Stream(String),

    #[error("model not found: {0}")]
    ModelMissing(String),

    #[error("whisper error: {0}")]
    Whisper(String),

    #[error("not initialised")]
    NotInitialised,

    #[error("already running")]
    AlreadyRunning,

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, ser: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        ser.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
