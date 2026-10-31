//! Áudio nativo com cpal: captura do microfone (→ PCM 48 kHz mono em quadros de 10 ms) e reprodução do
//! mixer (48 kHz mono → formato do dispositivo). Os streams do cpal não são `Send` em algumas
//! plataformas (CoreAudio), então cada um mora numa thread própria, que é encerrada no `Drop`.

use std::collections::VecDeque;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream};
use serde::Serialize;
use tokio::sync::mpsc;

use super::apm::ApmBridge;
use super::error::{classify_backend_message, MediaCode, MediaDevice, VoiceError};
use super::mixer::Mixer;
use super::resample::{downmix_to_mono, f32_to_i16, i16_to_f32, FrameChunker, LinearResampler};

/// Taxa e canais fixos do pipeline (LiveKit/Opus).
pub const SAMPLE_RATE: u32 = 48_000;
/// 10 ms a 48 kHz mono.
pub const FRAME_SAMPLES: usize = 480;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DeviceInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Input,
    Output,
}

fn media_device(dir: Direction) -> MediaDevice {
    match dir {
        Direction::Input => MediaDevice::Microphone,
        Direction::Output => MediaDevice::Speaker,
    }
}

/// Lista os dispositivos (o id é o nome do dispositivo no cpal; `""` = padrão do sistema).
pub fn list_devices(dir: Direction) -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let devices = match dir {
        Direction::Input => host.input_devices(),
        Direction::Output => host.output_devices(),
    };
    let mut out: Vec<DeviceInfo> = Vec::new();
    for d in devices.into_iter().flatten() {
        if let Ok(name) = d.name() {
            if !out.iter().any(|x| x.id == name) {
                out.push(DeviceInfo {
                    id: name.clone(),
                    label: name,
                });
            }
        }
    }
    out
}

fn find_device(dir: Direction, id: Option<&str>) -> Result<cpal::Device, VoiceError> {
    let host = cpal::default_host();
    let not_found = || VoiceError::media(MediaCode::NotFound, media_device(dir));
    match id.filter(|s| !s.is_empty()) {
        None => match dir {
            Direction::Input => host.default_input_device(),
            Direction::Output => host.default_output_device(),
        }
        .ok_or_else(not_found),
        Some(name) => {
            let mut devices = match dir {
                Direction::Input => host.input_devices(),
                Direction::Output => host.output_devices(),
            }
            .map_err(|e| backend_error(dir, &e.to_string()))?;
            // Dispositivo escolhido sumiu (desplugado): cai para o padrão em vez de falhar.
            Ok(devices
                .find(|d| d.name().is_ok_and(|n| n == name))
                .or(match dir {
                    Direction::Input => host.default_input_device(),
                    Direction::Output => host.default_output_device(),
                })
                .ok_or_else(not_found)?)
        }
    }
}

fn backend_error(dir: Direction, desc: &str) -> VoiceError {
    log::warn!("erro de áudio ({dir:?}): {desc}");
    VoiceError::media(classify_backend_message(desc), media_device(dir))
}

fn build_error(dir: Direction, e: &cpal::BuildStreamError) -> VoiceError {
    use cpal::BuildStreamError as E;
    match e {
        E::DeviceNotAvailable => VoiceError::media(MediaCode::NotFound, media_device(dir)),
        E::StreamConfigNotSupported | E::InvalidArgument => {
            VoiceError::media(MediaCode::Unsupported, media_device(dir))
        }
        other => backend_error(dir, &other.to_string()),
    }
}

/// Thread dona de um `Stream` do cpal. Encerra (e solta o dispositivo) no `Drop`.
pub struct StreamThread {
    stop: Option<std_mpsc::Sender<()>>,
    join: Option<JoinHandle<()>>,
}

impl StreamThread {
    fn spawn<F>(name: &str, build: F) -> Result<Self, VoiceError>
    where
        F: FnOnce() -> Result<Stream, VoiceError> + Send + 'static,
    {
        let (ready_tx, ready_rx) = std_mpsc::channel::<Result<(), VoiceError>>();
        let (stop_tx, stop_rx) = std_mpsc::channel::<()>();
        let join = std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                let stream = match build() {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                // Bloqueia até pedirem para parar (ou o dono sumir).
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| VoiceError::other(format!("não foi possível iniciar o áudio: {e}")))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                stop: Some(stop_tx),
                join: Some(join),
            }),
            Ok(Err(e)) => {
                let _ = join.join();
                Err(e)
            }
            Err(_) => {
                let _ = join.join();
                Err(VoiceError::other("a thread de áudio terminou sem iniciar"))
            }
        }
    }
}

impl Drop for StreamThread {
    fn drop(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Captura do microfone em andamento.
pub struct MicCapture {
    _thread: StreamThread,
}

/// Abre o microfone e envia quadros de 10 ms (48 kHz mono, i16) em `tx`. Se `tx` encher, descarta.
pub fn start_mic(
    device_id: Option<String>,
    tx: mpsc::Sender<Vec<i16>>,
) -> Result<MicCapture, VoiceError> {
    let thread = StreamThread::spawn("spook-mic", move || {
        let device = find_device(Direction::Input, device_id.as_deref())?;
        let config = device.default_input_config().map_err(|e| match e {
            cpal::DefaultStreamConfigError::DeviceNotAvailable => {
                VoiceError::media(MediaCode::NotFound, MediaDevice::Microphone)
            }
            other => backend_error(Direction::Input, &other.to_string()),
        })?;
        let channels = config.channels() as usize;
        let rate = config.sample_rate().0;
        let format = config.sample_format();
        let cfg: cpal::StreamConfig = config.into();
        let stream = match format {
            SampleFormat::F32 => build_input::<f32>(&device, &cfg, channels, rate, tx),
            SampleFormat::I16 => build_input::<i16>(&device, &cfg, channels, rate, tx),
            SampleFormat::U16 => build_input::<u16>(&device, &cfg, channels, rate, tx),
            SampleFormat::I32 => build_input::<i32>(&device, &cfg, channels, rate, tx),
            _ => Err(VoiceError::media(
                MediaCode::Unsupported,
                MediaDevice::Microphone,
            )),
        }?;
        stream
            .play()
            .map_err(|e| backend_error(Direction::Input, &e.to_string()))?;
        Ok(stream)
    })?;
    Ok(MicCapture { _thread: thread })
}

fn build_input<T>(
    device: &cpal::Device,
    cfg: &cpal::StreamConfig,
    channels: usize,
    rate: u32,
    tx: mpsc::Sender<Vec<i16>>,
) -> Result<Stream, VoiceError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut resampler = LinearResampler::new(rate, SAMPLE_RATE);
    let mut chunker = FrameChunker::new(FRAME_SAMPLES);
    let mut mono: Vec<f32> = Vec::with_capacity(4096);
    let mut resampled: Vec<f32> = Vec::with_capacity(4096);
    let mut floats: Vec<f32> = Vec::with_capacity(8192);
    device
        .build_input_stream(
            cfg,
            move |data: &[T], _| {
                floats.clear();
                floats.extend(data.iter().map(|&s| f32::from_sample(s)));
                mono.clear();
                downmix_to_mono(&floats, channels, &mut mono);
                resampled.clear();
                resampler.process(&mono, &mut resampled);
                chunker.push(&resampled, |frame| {
                    // Cheio = o consumidor atrasou: descarta em vez de crescer sem limite.
                    let _ = tx.try_send(frame);
                });
            },
            |e| log::warn!("erro no stream do microfone: {e}"),
            None,
        )
        .map_err(|e| build_error(Direction::Input, &e))
}

/// Reprodução do áudio remoto em andamento.
pub struct Playback {
    _thread: StreamThread,
}

/// Gera quadros de saída (qualquer taxa/canais) a partir do mixer 48 kHz mono. Lógica pura e testável.
pub struct OutputRenderer {
    mixer: Arc<Mutex<Mixer>>,
    /// Recebe o que tocamos como referência do eco (AEC).
    apm: Option<Arc<ApmBridge>>,
    resampler: LinearResampler,
    pending: VecDeque<f32>,
    channels: usize,
    pcm: Vec<i16>,
    floats: Vec<f32>,
    resampled: Vec<f32>,
}

impl OutputRenderer {
    pub fn new(
        mixer: Arc<Mutex<Mixer>>,
        apm: Option<Arc<ApmBridge>>,
        out_rate: u32,
        channels: usize,
    ) -> Self {
        Self {
            mixer,
            apm,
            resampler: LinearResampler::new(SAMPLE_RATE, out_rate),
            pending: VecDeque::new(),
            channels: channels.max(1),
            pcm: vec![0; FRAME_SAMPLES],
            floats: Vec::with_capacity(FRAME_SAMPLES),
            resampled: Vec::with_capacity(FRAME_SAMPLES * 2),
        }
    }

    /// Preenche `out` (intercalado, `channels` canais).
    pub fn fill(&mut self, out: &mut [f32]) {
        let frames = out.len() / self.channels;
        while self.pending.len() < frames {
            {
                let mut m = self.mixer.lock().unwrap_or_else(|e| e.into_inner());
                m.mix_into(&mut self.pcm);
            }
            // Os mesmos 10 ms que vão para o alto-falante são a referência do cancelador de eco.
            if let Some(apm) = &self.apm {
                apm.push_far(&self.pcm);
            }
            self.floats.clear();
            self.floats.extend(self.pcm.iter().map(|&s| i16_to_f32(s)));
            self.resampled.clear();
            self.resampler.process(&self.floats, &mut self.resampled);
            self.pending.extend(self.resampled.iter().copied());
        }
        for frame in out.chunks_exact_mut(self.channels) {
            let s = self.pending.pop_front().unwrap_or(0.0);
            frame.fill(s);
        }
    }
}

/// Abre a saída de áudio e toca o que o mixer tiver.
pub fn start_playback(
    device_id: Option<String>,
    mixer: Arc<Mutex<Mixer>>,
    apm: Option<Arc<ApmBridge>>,
) -> Result<Playback, VoiceError> {
    let thread = StreamThread::spawn("spook-out", move || {
        let device = find_device(Direction::Output, device_id.as_deref())?;
        let config = device.default_output_config().map_err(|e| match e {
            cpal::DefaultStreamConfigError::DeviceNotAvailable => {
                VoiceError::media(MediaCode::NotFound, MediaDevice::Speaker)
            }
            other => backend_error(Direction::Output, &other.to_string()),
        })?;
        let channels = config.channels() as usize;
        let rate = config.sample_rate().0;
        let format = config.sample_format();
        let cfg: cpal::StreamConfig = config.into();
        let stream = match format {
            SampleFormat::F32 => build_output::<f32>(&device, &cfg, channels, rate, mixer, apm),
            SampleFormat::I16 => build_output::<i16>(&device, &cfg, channels, rate, mixer, apm),
            SampleFormat::U16 => build_output::<u16>(&device, &cfg, channels, rate, mixer, apm),
            SampleFormat::I32 => build_output::<i32>(&device, &cfg, channels, rate, mixer, apm),
            _ => Err(VoiceError::media(
                MediaCode::Unsupported,
                MediaDevice::Speaker,
            )),
        }?;
        stream
            .play()
            .map_err(|e| backend_error(Direction::Output, &e.to_string()))?;
        Ok(stream)
    })?;
    Ok(Playback { _thread: thread })
}

fn build_output<T>(
    device: &cpal::Device,
    cfg: &cpal::StreamConfig,
    channels: usize,
    rate: u32,
    mixer: Arc<Mutex<Mixer>>,
    apm: Option<Arc<ApmBridge>>,
) -> Result<Stream, VoiceError>
where
    T: SizedSample + FromSample<f32>,
{
    let mut renderer = OutputRenderer::new(mixer, apm, rate, channels);
    let mut scratch: Vec<f32> = Vec::new();
    device
        .build_output_stream(
            cfg,
            move |data: &mut [T], _| {
                scratch.resize(data.len(), 0.0);
                renderer.fill(&mut scratch);
                for (o, &s) in data.iter_mut().zip(scratch.iter()) {
                    *o = T::from_sample(s);
                }
            },
            |e| log::warn!("erro no stream de saída: {e}"),
            None,
        )
        .map_err(|e| build_error(Direction::Output, &e))
}

/// Converte um bloco i16 em f32 (auxiliar dos testes de integração).
pub fn pcm_to_f32(pcm: &[i16]) -> Vec<f32> {
    pcm.iter().map(|&s| i16_to_f32(s)).collect()
}

/// Gera `n` amostras de um tom (auxiliar de testes).
pub fn tone(freq: f32, start: usize, n: usize, amplitude: f32) -> Vec<i16> {
    (start..start + n)
        .map(|i| {
            f32_to_i16(
                (2.0 * std::f32::consts::PI * freq * i as f32 / SAMPLE_RATE as f32).sin()
                    * amplitude,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mixer_with(samples: &[i16]) -> Arc<Mutex<Mixer>> {
        let m = Arc::new(Mutex::new(Mixer::new()));
        m.lock().unwrap().push("a", samples);
        m
    }

    #[test]
    fn renderer_passthrough_at_48k_stereo() {
        let pcm = tone(440.0, 0, 4800, 0.5);
        let mixer = mixer_with(&pcm);
        let mut r = OutputRenderer::new(mixer, None, 48_000, 2);
        let mut out = vec![0f32; 960 * 2];
        r.fill(&mut out);
        // os dois canais são iguais e há sinal
        assert!(out.chunks(2).all(|f| f[0] == f[1]));
        assert!(out.iter().any(|s| s.abs() > 0.3));
    }

    #[test]
    fn renderer_resamples_to_the_device_rate() {
        // 1 s de tom em 48 kHz tocado num dispositivo de 44,1 kHz → ~44100 quadros úteis
        let pcm = tone(300.0, 0, 48_000, 0.5);
        let mixer = mixer_with(&pcm);
        let mut r = OutputRenderer::new(mixer.clone(), None, 44_100, 1);
        // o mixer guarda no máximo 200 ms: alimenta aos poucos
        let mut fed = 9_600;
        let mut total = Vec::new();
        for _ in 0..(44_100 / 441) {
            let mut chunk = vec![0f32; 441];
            r.fill(&mut chunk);
            total.extend(chunk);
            if fed < pcm.len() {
                let end = (fed + 480).min(pcm.len());
                mixer.lock().unwrap().push("a", &pcm[fed..end]);
                fed = end;
            }
        }
        let crossings = total
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count();
        assert!(
            (crossings as i64 - 300).abs() <= 6,
            "cruzamentos {crossings}"
        );
    }

    #[test]
    fn renderer_feeds_what_it_plays_to_the_echo_canceller() {
        use crate::voice::apm::{ApmBridge, AudioProcessingSettings};
        let apm = Arc::new(ApmBridge::new(AudioProcessingSettings::default()));
        let mixer = mixer_with(&tone(440.0, 0, 4800, 0.5));
        let mut r = OutputRenderer::new(mixer, Some(apm.clone()), 48_000, 2);
        let mut out = vec![0f32; 480 * 2 * 5]; // 5 quadros de 10 ms
        r.fill(&mut out);
        assert!((5..=6).contains(&apm.far_frames()), "{}", apm.far_frames());
    }

    #[test]
    fn renderer_plays_silence_when_deafened() {
        let mixer = mixer_with(&tone(440.0, 0, 4800, 0.5));
        mixer.lock().unwrap().set_deafened(true);
        let mut r = OutputRenderer::new(mixer, None, 48_000, 2);
        let mut out = vec![1f32; 960 * 2];
        r.fill(&mut out);
        assert!(out.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn tone_helper_has_the_requested_amplitude() {
        let t = tone(1000.0, 0, 480, 0.5);
        let peak = t.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!((peak as f32 - 0.5 * i16::MAX as f32).abs() < 600.0);
        assert_eq!(pcm_to_f32(&t).len(), 480);
    }
}
