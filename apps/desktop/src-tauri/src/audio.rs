//! Cross-platform microphone capture using `cpal`.
//!
//! Design notes
//! ------------
//!
//!  • cpal's input callback runs on a *real-time* OS thread; we MUST NOT
//!    allocate, lock, or call into `whisper-rs` from there. We push samples
//!    into a lock-free SPSC ring buffer and let a worker thread do the work.
//!
//!  • cpal can deliver any sample format / sample rate; we always normalise
//!    to mono `f32` @ 16 kHz, since that's what whisper.cpp expects. Down-
//!    mixing is a simple stereo-average; resampling is naïve linear (good
//!    enough for speech — swap to `rubato` later if you need higher quality).

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Sample, SampleFormat, StreamConfig};
use ringbuf::{traits::Producer as _, traits::Split, HeapRb};
use serde::Serialize;

use crate::error::{Error, Result};

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Public, JSON-serialisable description of an input device.
#[derive(Debug, Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub label: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

/// Enumerate all input devices visible to the default host.
pub fn list_devices() -> Result<Vec<AudioDeviceInfo>> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    let devices = host
        .input_devices()
        .map_err(|e| Error::Device(e.to_string()))?;

    let mut out = Vec::new();
    for d in devices {
        let name = d.name().unwrap_or_else(|_| "<unknown>".to_string());
        let is_default = name == default_name;
        out.push(AudioDeviceInfo {
            id: name.clone(),
            label: name,
            is_default,
        });
    }
    Ok(out)
}

/// Consumer side (held by the whisper task).
pub type Consumer = ringbuf::HeapCons<f32>;

/// A running capture stream. Drop it (or call `stop`) to tear down cpal.
pub struct CaptureStream {
    _stream: cpal::Stream,
    /// Set to false to stop pushing into the ring (also auto-handled on Drop).
    alive: Arc<AtomicBool>,
}

// SAFETY: CaptureStream is moved to a dedicated OS thread that solely owns it.
// The !Send bound comes from cpal's WASAPI raw pointers on Windows; we never
// share the stream across threads simultaneously.
unsafe impl Send for CaptureStream {}

impl CaptureStream {
    pub fn stop(self) {
        self.alive.store(false, Ordering::Relaxed);
        // _stream dropped here ⇒ cpal stops the OS stream automatically.
    }
}

/// Start capture and return a consumer the caller can `pop_slice` from.
///
/// `device_id` matches the `id` returned by `list_devices`. Pass `None` for
/// the system default.
pub fn start_capture(
    device_id: Option<&str>,
    rb_capacity: usize,
) -> Result<(CaptureStream, Consumer, u32)> {
    let host = cpal::default_host();
    let device: Device = match device_id {
        Some(id) => host
            .input_devices()
            .map_err(|e| Error::Device(e.to_string()))?
            .find(|d| d.name().map(|n| n == id).unwrap_or(false))
            .ok_or_else(|| Error::Device(format!("device not found: {id}")))?,
        None => host
            .default_input_device()
            .ok_or_else(|| Error::Device("no default input device".into()))?,
    };

    let supported = device
        .default_input_config()
        .map_err(|e| Error::Device(e.to_string()))?;

    let sample_format = supported.sample_format();
    let in_sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;

    tracing::info!(
        device = %device.name().unwrap_or_default(),
        sample_format = ?sample_format,
        sample_rate = in_sample_rate,
        channels,
        "starting capture"
    );

    let config: StreamConfig = supported.into();

    let rb = HeapRb::<f32>::new(rb_capacity.max(TARGET_SAMPLE_RATE as usize));
    let (mut producer, consumer) = rb.split();
    let alive = Arc::new(AtomicBool::new(true));
    let alive_cb = alive.clone();

    // ResampleCtx: very simple linear resampler from in_sample_rate → 16k.
    let mut resampler = LinearResampler::new(in_sample_rate, TARGET_SAMPLE_RATE);

    let err_fn = |err| tracing::error!("audio stream error: {err}");

    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| {
                if !alive_cb.load(Ordering::Relaxed) {
                    return;
                }
                let mono = downmix_to_mono(data, channels);
                let resampled = resampler.process(&mono);
                let _ = producer.push_slice(&resampled);
            },
            err_fn,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| {
                if !alive_cb.load(Ordering::Relaxed) {
                    return;
                }
                let f: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                let mono = downmix_to_mono(&f, channels);
                let resampled = resampler.process(&mono);
                let _ = producer.push_slice(&resampled);
            },
            err_fn,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _| {
                if !alive_cb.load(Ordering::Relaxed) {
                    return;
                }
                let f: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                let mono = downmix_to_mono(&f, channels);
                let resampled = resampler.process(&mono);
                let _ = producer.push_slice(&resampled);
            },
            err_fn,
            None,
        ),
        other => {
            return Err(Error::Stream(format!(
                "unsupported sample format: {other:?}"
            )))
        }
    }
    .map_err(|e| Error::Stream(e.to_string()))?;

    stream.play().map_err(|e| Error::Stream(e.to_string()))?;

    Ok((
        CaptureStream {
            _stream: stream,
            alive,
        },
        consumer,
        TARGET_SAMPLE_RATE,
    ))
}

fn downmix_to_mono(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    let frames = data.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let mut sum = 0.0f32;
        for c in 0..channels {
            sum += data[base + c];
        }
        out.push(sum / channels as f32);
    }
    out
}

/// Naïve fixed-ratio linear resampler. Good enough for 48k→16k speech.
struct LinearResampler {
    in_rate: u32,
    out_rate: u32,
    /// Fractional position in the input stream (in samples).
    pos: f64,
    /// Last sample of the previous chunk, used for cross-chunk interpolation.
    last: f32,
}

impl LinearResampler {
    fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            in_rate,
            out_rate,
            pos: 0.0,
            last: 0.0,
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.in_rate == self.out_rate {
            return input.to_vec();
        }
        let step = self.in_rate as f64 / self.out_rate as f64;
        let mut out = Vec::with_capacity((input.len() as f64 / step).ceil() as usize);
        let mut pos = self.pos;
        while pos < input.len() as f64 {
            let i = pos.floor() as usize;
            let frac = pos - i as f64;
            let a = if i == 0 { self.last } else { input[i - 1] };
            let b = if i < input.len() { input[i] } else { a };
            out.push(a + (b - a) * frac as f32);
            pos += step;
        }
        // Carry-over for next chunk: keep fractional position relative to
        // the *next* input buffer, and remember the last sample.
        self.pos = pos - input.len() as f64;
        if let Some(&v) = input.last() {
            self.last = v;
        }
        out
    }
}
