//! Entradas SINTÉTICAS (tom + barras de cor) no lugar de microfone, câmera e tela. Existem para o teste de
//! integração contra o LiveKit de desenvolvimento, que roda sem dispositivos reais. Em produção nunca são
//! ligadas (`VoiceCore::use_synthetic_inputs` só é chamado pelos testes).

use std::sync::atomic::Ordering;
use std::time::Duration;

use libwebrtc::video_frame::I420Buffer;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::audio::{tone, FRAME_SAMPLES};
use super::capture::{CaptureThread, VideoOut};

#[derive(Debug, Clone, Copy)]
pub struct SyntheticInputs {
    pub tone_hz: f32,
    pub video: (u32, u32),
    pub fps: u32,
}

/// Tarefa que gera quadros de 10 ms de um tom em tempo real. Para ao soltar.
pub struct ToneTask(JoinHandle<()>);

impl Drop for ToneTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub fn start_tone(hz: f32, tx: mpsc::Sender<Vec<i16>>) -> ToneTask {
    ToneTask(tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(10));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
        let mut n = 0usize;
        loop {
            tick.tick().await;
            let frame = tone(hz, n, FRAME_SAMPLES, 0.5);
            n += FRAME_SAMPLES;
            if tx.send(frame).await.is_err() {
                break;
            }
        }
    }))
}

/// Cores das quatro barras (R, G, B) do padrão: vermelho, verde, azul, branco.
pub const BARS: [(u8, u8, u8); 4] = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255)];

/// Converte uma cor RGB (BT.601, faixa limitada) para Y, U, V — a mesma que o libyuv usa.
pub fn rgb_to_yuv(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let (r, g, b) = (r as f32, g as f32, b as f32);
    let y = 16.0 + 0.257 * r + 0.504 * g + 0.098 * b;
    let u = 128.0 - 0.148 * r - 0.291 * g + 0.439 * b;
    let v = 128.0 + 0.439 * r - 0.368 * g - 0.071 * b;
    (y.round() as u8, u.round() as u8, v.round() as u8)
}

/// Quadro I420 com quatro barras verticais (largura/altura pares).
pub fn color_bars(w: u32, h: u32) -> I420Buffer {
    let mut b = I420Buffer::new(w, h);
    let (sy, su, sv) = b.strides();
    let (y, u, v) = b.data_mut();
    let bar = |col: usize| (col * 4 / w as usize).min(3);
    for row in 0..h as usize {
        for col in 0..w as usize {
            let (r, g, bl) = BARS[bar(col)];
            y[row * sy as usize + col] = rgb_to_yuv(r, g, bl).0;
        }
    }
    for row in 0..(h as usize / 2) {
        for col in 0..(w as usize / 2) {
            let (r, g, bl) = BARS[bar(col * 2)];
            let (_, cu, cv) = rgb_to_yuv(r, g, bl);
            u[row * su as usize + col] = cu;
            v[row * sv as usize + col] = cv;
        }
    }
    b
}

/// Captura sintética: empurra as barras de cor no funil de vídeo na taxa pedida.
pub fn start_video(mut out: VideoOut, cfg: SyntheticInputs) -> Result<CaptureThread, String> {
    let (w, h) = (cfg.video.0 & !1, cfg.video.1 & !1);
    let interval = Duration::from_millis(1000 / u64::from(cfg.fps.max(1)));
    // O parâmetro `E` do canal de "pronto" não é usado aqui.
    let spawned = CaptureThread::spawn::<String, _>("spook-synth-video", move |stop, ready| {
        let _ = ready.send(Ok(()));
        while !stop.load(Ordering::SeqCst) {
            out.push(color_bars(w, h));
            std::thread::sleep(interval);
        }
    });
    spawned.map(|(thread, _ready)| thread)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::frames::encode_jpeg;

    #[test]
    fn bars_survive_the_jpeg_pipeline() {
        let src = color_bars(640, 360);
        let (jpeg, w, h) = encode_jpeg(&src, (1280, 720), 85).unwrap();
        assert_eq!((w, h), (640, 360));
        let img = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
            .unwrap()
            .to_rgb8();
        for (i, (r, g, b)) in BARS.iter().enumerate() {
            let px = img.get_pixel(80 + 160 * i as u32, 180).0;
            let d = |a: u8, e: u8| (a as i32 - e as i32).abs();
            assert!(
                d(px[0], *r) < 40 && d(px[1], *g) < 40 && d(px[2], *b) < 40,
                "barra {i}: esperado {:?}, veio {:?}",
                (r, g, b),
                px
            );
        }
    }

    #[test]
    fn yuv_conversion_matches_known_values() {
        assert_eq!(rgb_to_yuv(255, 255, 255).0, 235);
        assert_eq!(rgb_to_yuv(0, 0, 0).0, 16);
        let (_, u, v) = rgb_to_yuv(255, 0, 0);
        assert!(v > 200 && u < 120);
    }
}
