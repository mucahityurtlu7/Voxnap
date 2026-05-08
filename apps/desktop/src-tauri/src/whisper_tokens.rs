//! Whisper-specific tokenizer helpers.
//!
//! Whisper uses a GPT-2 byte-level BPE tokenizer with extra special tokens
//! reserved for language tags, task selection (`transcribe` / `translate`),
//! timestamps, and notimestamps. The HuggingFace `tokenizers` crate handles
//! the byte-level BPE encoding; this module wraps it with the Whisper-
//! specific token-id arithmetic and the SOT (start-of-transcript) prompt
//! construction the decoder expects.
//!
//! Token id layout (multilingual `large-v3` vocab; the english-only models
//! use slightly different offsets — we read the actual ids from the
//! tokenizer's special-tokens map at load time so this module stays
//! version-agnostic).
//!
//!   <|endoftext|>          = 50257   (vocab end of regular BPE)
//!   <|startoftranscript|>  = 50258
//!   <|en|> ... <|jw|>      = 50259..(50259+99)   language tags
//!   <|translate|>          = 50358
//!   <|transcribe|>         = 50359
//!   <|notimestamps|>       = 50362
//!   <|0.00|> ... <|30.00|> = 50364..             timestamp tokens
//!
//! We resolve the actual ids dynamically because (a) english-only and
//! multilingual vocabs differ, (b) Whisper v3 added a 100th language tag.

#![allow(dead_code)] // Phase 2A: spec only; consumed in Phase 2B by the decoder loop.

use std::path::Path;

use tokenizers::Tokenizer;

use crate::error::{Error, Result};

/// Special-token ids resolved from the tokenizer's vocab. Cached so the
/// decoder loop doesn't string-lookup on every step.
#[derive(Debug, Clone)]
pub struct WhisperSpecials {
    pub eot: u32,
    pub sot: u32,
    pub transcribe: u32,
    pub translate: u32,
    pub notimestamps: u32,
    pub no_speech: u32,
    /// First language-tag id (English). The other 99 follow contiguously
    /// in the same order as `LANGUAGE_CODES`.
    pub lang_base: u32,
    /// First timestamp-token id (`<|0.00|>`). Subsequent timestamp tokens
    /// `<|0.02|>`, `<|0.04|>`, … run contiguously up to `<|30.00|>`. Used
    /// to detect timestamp tokens emitted by the decoder so the engine
    /// can recover word-level timing in Phase 2C+.
    pub timestamp_begin: u32,
}


/// 99 + 1 BCP-47 codes Whisper supports, ordered to match its vocab.
/// Index `i` corresponds to token id `lang_base + i`.
pub const LANGUAGE_CODES: &[&str] = &[
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv",
    "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no",
    "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr",
    "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
    "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu",
    "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl",
    "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su", "yue",
];

/// Loaded Whisper tokenizer + resolved specials.
pub struct WhisperTokenizer {
    pub inner: Tokenizer,
    pub specials: WhisperSpecials,
    /// True for the `*-en` model variants. Affects the SOT prefix:
    /// english-only models omit the language tag *and* the
    /// `transcribe/translate` selector.
    pub english_only: bool,
}

impl WhisperTokenizer {
    /// Load `tokenizer.json` from disk and resolve special-token ids.
    pub fn load(path: &Path, english_only: bool) -> Result<Self> {
        let inner = Tokenizer::from_file(path)
            .map_err(|e| Error::Other(format!("load tokenizer.json: {e}")))?;

        // The vocab maps the literal special-token strings to their ids.
        // We use the vocab API (not `token_to_id` which checks the added-
        // vocabulary table separately) so unification across HF versions
        // stays simple.
        let resolve = |tok: &str| -> Result<u32> {
            inner
                .token_to_id(tok)
                .ok_or_else(|| Error::Other(format!("missing special token `{tok}` in vocab")))
        };

        // The first timestamp token is `<|0.00|>`. Different optimum
        // exports format it as `<|0.00|>` (most common) or `<|0|>`
        // (legacy). We try both before giving up — if neither is
        // present the model bundle was exported without timestamp
        // support, which is fine: callers stick with notimestamps.
        let timestamp_begin = inner
            .token_to_id("<|0.00|>")
            .or_else(|| inner.token_to_id("<|0|>"))
            // Falls back to one past `notimestamps`, matching OpenAI's
            // canonical layout. Wrong answers from this branch are
            // harmless because `is_timestamp()` only ever returns true
            // for ids ≥ this value, so the worst case is timestamp
            // detection silently degrading to "no timestamps observed".
            .unwrap_or_else(|| {
                inner
                    .token_to_id("<|notimestamps|>")
                    .map(|n| n + 1)
                    .unwrap_or(u32::MAX)
            });

        let specials = WhisperSpecials {
            eot: resolve("<|endoftext|>")?,
            sot: resolve("<|startoftranscript|>")?,
            transcribe: resolve("<|transcribe|>")?,
            translate: resolve("<|translate|>")?,
            notimestamps: resolve("<|notimestamps|>")?,
            no_speech: resolve("<|nospeech|>").unwrap_or(0),
            lang_base: resolve("<|en|>")?,
            timestamp_begin,
        };


        Ok(Self {
            inner,
            specials,
            english_only,
        })
    }

    /// Map an ISO-639-1 language code to its Whisper language-tag token id.
    /// Falls back to `<|en|>` for unknown codes.
    pub fn language_token(&self, code: &str) -> u32 {
        if let Some(idx) = LANGUAGE_CODES.iter().position(|c| *c == code) {
            self.specials.lang_base + idx as u32
        } else {
            self.specials.lang_base
        }
    }

    /// Build the start-of-transcript prefix the decoder is conditioned on.
    ///
    /// `timestamps = false` (the default in earlier phases) appends
    /// `<|notimestamps|>` so the decoder produces only text tokens.
    /// `timestamps = true` omits that marker — the decoder will then
    /// interleave `<|x.xx|>` timestamp tokens between text spans, which
    /// the engine slices into segments via `is_timestamp` /
    /// `timestamp_seconds`.
    ///
    ///  • Multilingual + timestamps: `[SOT, <|lang|>, <|task|>]`
    ///  • Multilingual + notimestamps: `[SOT, <|lang|>, <|task|>, <|notimestamps|>]`
    ///  • English-only + timestamps:  `[SOT]`
    ///  • English-only + notimestamps: `[SOT, <|notimestamps|>]`
    pub fn sot_prefix(&self, language: &str, translate: bool) -> Vec<u32> {
        self.sot_prefix_with(language, translate, false)
    }

    /// Same as [`sot_prefix`] but lets the caller opt into timestamp tokens.
    pub fn sot_prefix_with(
        &self,
        language: &str,
        translate: bool,
        timestamps: bool,
    ) -> Vec<u32> {
        if self.english_only {
            return if timestamps {
                vec![self.specials.sot]
            } else {
                vec![self.specials.sot, self.specials.notimestamps]
            };
        }
        let lang = self.language_token(language);
        let task = if translate {
            self.specials.translate
        } else {
            self.specials.transcribe
        };
        if timestamps {
            vec![self.specials.sot, lang, task]
        } else {
            vec![self.specials.sot, lang, task, self.specials.notimestamps]
        }
    }

    /// Decode a token sequence into a UTF-8 string, dropping any special
    /// tokens (`skip_special_tokens=true`).
    pub fn decode(&self, ids: &[u32]) -> Result<String> {
        self.inner
            .decode(ids, true)
            .map_err(|e| Error::Other(format!("decode tokens: {e}")))
    }

    /// Returns true if `id` is the end-of-transcript marker (or any other
    /// token that should terminate the autoregressive loop).
    pub fn is_terminal(&self, id: u32) -> bool {
        id == self.specials.eot
    }

    /// True if `id` is one of the `<|x.xx|>` timestamp tokens.
    pub fn is_timestamp(&self, id: u32) -> bool {
        id >= self.specials.timestamp_begin && id < self.specials.eot
    }

    /// Convert a timestamp token id into its seconds value (0.00 … 30.00).
    /// Returns `None` for ids that are not timestamps.
    ///
    /// Whisper's timestamp tokens are spaced at 20 ms intervals
    /// (`<|0.00|>`, `<|0.02|>`, `<|0.04|>`, …), so the seconds value is
    /// `(id − timestamp_begin) × 0.02`.
    pub fn timestamp_seconds(&self, id: u32) -> Option<f32> {
        if !self.is_timestamp(id) {
            return None;
        }
        let offset = id - self.specials.timestamp_begin;
        Some(offset as f32 * 0.02)
    }
}


