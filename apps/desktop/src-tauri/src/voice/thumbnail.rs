//! Miniaturas do seletor de tela (lógica pura, sem `scap` nem `tauri`): reduz um quadro capturado mantendo a
//! proporção, codifica em JPEG pequeno e monta o payload em base64. Nada aqui toca disco nem faz log do conteúdo.

use jpeg_encoder::{ColorType, Encoder};
use serde::Serialize;

/// Caixa máxima da miniatura (a proporção do alvo é mantida dentro dela; nunca amplia).
pub const THUMB_MAX_W: u32 = 320;
pub const THUMB_MAX_H: u32 = 180;
/// Qualidades tentadas em ordem até caber em `MAX_JPEG_BYTES`.
pub const JPEG_QUALITIES: [u8; 3] = [60, 45, 30];
/// Teto de cada miniatura em JPEG (alvo ~25 KB; acima disso é descartada em vez de estourar o IPC).
pub const MAX_JPEG_BYTES: usize = 40 * 1024;
/// Quantidade máxima de fontes por pedido (limita o tamanho total do payload: 32 x ~54 KB em base64).
pub const MAX_SOURCES: usize = 32;

/// Ordem dos bytes de um pixel de 32 bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    Bgra,
    Rgba,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ThumbError {
    #[error("quadro vazio ou com dimensões inválidas")]
    Empty,
    #[error("buffer menor do que as dimensões declaradas")]
    ShortBuffer,
    #[error("falha ao codificar JPEG")]
    Jpeg,
    #[error("miniatura acima do limite de tamanho")]
    TooLarge,
}

/// Motivo de uma miniatura ausente (o webview mostra um ícone no lugar).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ThumbFailure {
    /// macOS: sem permissão de gravação de tela.
    Permission,
    /// A captura não respondeu a tempo.
    Timeout,
    /// Plataforma sem suporte à captura.
    Unsupported,
    /// Qualquer outra falha (fonte sumiu, quadro inválido, panic contido).
    Failed,
}

/// Uma miniatura (ou a falha dela) para o webview.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenThumbnail {
    pub id: String,
    /// JPEG em base64 (sem prefixo `data:`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jpeg: Option<String>,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ThumbFailure>,
}

impl ScreenThumbnail {
    pub fn ok(id: &str, t: &Thumb) -> Self {
        Self {
            id: id.to_string(),
            jpeg: Some(to_base64(&t.jpeg)),
            width: t.width,
            height: t.height,
            error: None,
        }
    }

    pub fn failed(id: &str, why: ThumbFailure) -> Self {
        Self {
            id: id.to_string(),
            jpeg: None,
            width: 0,
            height: 0,
            error: Some(why),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thumb {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Tamanho reduzido que cabe em `max`, mantendo a proporção. Nunca amplia; mínimo 1x1.
pub fn fit_size(w: u32, h: u32, max_w: u32, max_h: u32) -> Option<(u32, u32)> {
    if w == 0 || h == 0 || max_w == 0 || max_h == 0 {
        return None;
    }
    if w <= max_w && h <= max_h {
        return Some((w, h));
    }
    // escala = min(max_w/w, max_h/h), em inteiros (u64) para não perder precisão.
    let (w64, h64) = (w as u64, h as u64);
    let (tw, th) = if w64 * max_h as u64 >= h64 * max_w as u64 {
        // limitado pela largura
        let th = (h64 * max_w as u64 / w64).max(1);
        (max_w as u64, th)
    } else {
        let tw = (w64 * max_h as u64 / h64).max(1);
        (tw, max_h as u64)
    };
    Some((tw as u32, th as u32))
}

/// Stride (bytes por linha) de um quadro de 32 bits, tolerando preenchimento no fim das linhas.
fn stride_of(len: usize, width: usize, height: usize) -> Option<usize> {
    let min = width.checked_mul(4)?;
    if len < min.checked_mul(height)? {
        return None;
    }
    let s = len / height;
    Some(if s >= min { s } else { min })
}

/// Reduz pixels de 32 bits para RGB (3 bytes) `tw` x `th`: média de uma grade de até 4x4 amostras por pixel de
/// destino (barato mesmo em 4K e suave o bastante para uma miniatura).
pub fn downscale_rgb(
    data: &[u8],
    width: u32,
    height: u32,
    order: Order,
    tw: u32,
    th: u32,
) -> Result<Vec<u8>, ThumbError> {
    if width == 0 || height == 0 || tw == 0 || th == 0 {
        return Err(ThumbError::Empty);
    }
    let (w, h) = (width as usize, height as usize);
    let stride = stride_of(data.len(), w, h).ok_or(ThumbError::ShortBuffer)?;
    let (tw_u, th_u) = (tw as usize, th as usize);
    let (ri, gi, bi) = match order {
        Order::Bgra => (2, 1, 0),
        Order::Rgba => (0, 1, 2),
    };
    let mut out = vec![0u8; tw_u * th_u * 3];
    for ty in 0..th_u {
        let y0 = ty * h / th_u;
        let y1 = (((ty + 1) * h) / th_u).clamp(y0 + 1, h);
        let ystep = ((y1 - y0) / 4).max(1);
        for tx in 0..tw_u {
            let x0 = tx * w / tw_u;
            let x1 = (((tx + 1) * w) / tw_u).clamp(x0 + 1, w);
            let xstep = ((x1 - x0) / 4).max(1);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            let mut y = y0;
            while y < y1 {
                let row = y * stride;
                let mut x = x0;
                while x < x1 {
                    let p = row + x * 4;
                    r += data[p + ri] as u32;
                    g += data[p + gi] as u32;
                    b += data[p + bi] as u32;
                    n += 1;
                    x += xstep;
                }
                y += ystep;
            }
            let o = (ty * tw_u + tx) * 3;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
        }
    }
    Ok(out)
}

fn encode_rgb(rgb: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>, ThumbError> {
    let mut jpeg = Vec::with_capacity((w * h / 6) as usize);
    Encoder::new(&mut jpeg, quality)
        .encode(rgb, w as u16, h as u16, ColorType::Rgb)
        .map_err(|_| ThumbError::Jpeg)?;
    Ok(jpeg)
}

/// Quadro capturado → miniatura JPEG. Baixa a qualidade até caber em `MAX_JPEG_BYTES`.
pub fn build(data: &[u8], width: u32, height: u32, order: Order) -> Result<Thumb, ThumbError> {
    let (tw, th) = fit_size(width, height, THUMB_MAX_W, THUMB_MAX_H).ok_or(ThumbError::Empty)?;
    let rgb = downscale_rgb(data, width, height, order, tw, th)?;
    for q in JPEG_QUALITIES {
        let jpeg = encode_rgb(&rgb, tw, th, q)?;
        if jpeg.len() <= MAX_JPEG_BYTES {
            return Ok(Thumb {
                jpeg,
                width: tw,
                height: th,
            });
        }
    }
    Err(ThumbError::TooLarge)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Base64 padrão (com `=`), sem dependência extra.
pub fn to_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = match chunk.len() {
            3 => (chunk[0] as u32) << 16 | (chunk[1] as u32) << 8 | chunk[2] as u32,
            2 => (chunk[0] as u32) << 16 | (chunk[1] as u32) << 8,
            _ => (chunk[0] as u32) << 16,
        };
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, px: [u8; 4]) -> Vec<u8> {
        px.iter()
            .copied()
            .cycle()
            .take((w * h * 4) as usize)
            .collect()
    }

    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_size(1920, 1080, 320, 180), Some((320, 180)));
        assert_eq!(fit_size(3840, 1600, 320, 180), Some((320, 133)));
        assert_eq!(fit_size(1080, 1920, 320, 180), Some((101, 180)));
        assert_eq!(fit_size(200, 100, 320, 180), Some((200, 100)));
        assert_eq!(fit_size(100_000, 1, 320, 180), Some((320, 1)));
        assert_eq!(fit_size(0, 10, 320, 180), None);
        assert_eq!(fit_size(10, 10, 0, 180), None);
    }

    #[test]
    fn downscale_maps_bgra_and_rgba_channels() {
        // BGRA vermelho puro: B=0,G=0,R=255
        let bgra = solid(64, 36, [0, 0, 255, 255]);
        let rgb = downscale_rgb(&bgra, 64, 36, Order::Bgra, 8, 4).unwrap();
        assert_eq!(&rgb[..3], &[255, 0, 0]);
        assert_eq!(rgb.len(), 8 * 4 * 3);
        let rgba = solid(64, 36, [0, 0, 255, 255]); // RGBA azul
        let rgb = downscale_rgb(&rgba, 64, 36, Order::Rgba, 8, 4).unwrap();
        assert_eq!(&rgb[..3], &[0, 0, 255]);
    }

    #[test]
    fn downscale_averages_halves() {
        // metade esquerda branca, direita preta
        let (w, h) = (64u32, 8u32);
        let mut d = Vec::new();
        for _ in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { 255 } else { 0 };
                d.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let rgb = downscale_rgb(&d, w, h, Order::Bgra, 4, 1).unwrap();
        assert_eq!(rgb[0], 255);
        assert_eq!(rgb[3 * 3], 0);
    }

    #[test]
    fn downscale_tolerates_stride_padding_and_rejects_short_buffers() {
        let (w, h) = (10u32, 4u32);
        let padded = vec![128u8; (w as usize * 4 + 8) * h as usize];
        assert!(downscale_rgb(&padded, w, h, Order::Bgra, 5, 2).is_ok());
        assert_eq!(
            downscale_rgb(&[0u8; 12], w, h, Order::Bgra, 5, 2),
            Err(ThumbError::ShortBuffer)
        );
        assert_eq!(
            downscale_rgb(&[], 0, 0, Order::Bgra, 5, 2),
            Err(ThumbError::Empty)
        );
    }

    #[test]
    fn build_makes_a_small_valid_jpeg() {
        let src = solid(3840, 2160, [30, 90, 200, 255]);
        let t = build(&src, 3840, 2160, Order::Bgra).unwrap();
        assert_eq!((t.width, t.height), (320, 180));
        assert_eq!(&t.jpeg[..2], &[0xFF, 0xD8]);
        assert!(t.jpeg.len() <= MAX_JPEG_BYTES);
    }

    #[test]
    fn noisy_frames_fall_back_to_lower_quality_or_fail_cleanly() {
        // ruído pseudoaleatório: o pior caso para o JPEG
        let (w, h) = (640u32, 360u32);
        let mut s = 12345u32;
        let d: Vec<u8> = (0..w * h * 4)
            .map(|_| {
                s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                (s >> 24) as u8
            })
            .collect();
        match build(&d, w, h, Order::Rgba) {
            Ok(t) => assert!(t.jpeg.len() <= MAX_JPEG_BYTES),
            Err(e) => assert_eq!(e, ThumbError::TooLarge),
        }
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(to_base64(b""), "");
        assert_eq!(to_base64(b"f"), "Zg==");
        assert_eq!(to_base64(b"fo"), "Zm8=");
        assert_eq!(to_base64(b"foo"), "Zm9v");
        assert_eq!(to_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn payload_serializes_in_camel_case_without_empty_fields() {
        let ok = ScreenThumbnail::ok(
            "display:1",
            &Thumb {
                jpeg: vec![1, 2, 3],
                width: 320,
                height: 180,
            },
        );
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v["jpeg"], "AQID");
        assert!(v.get("error").is_none());
        let bad = serde_json::to_value(ScreenThumbnail::failed(
            "window:2",
            ThumbFailure::Permission,
        ))
        .unwrap();
        assert_eq!(bad["error"], "permission");
        assert!(bad.get("jpeg").is_none());
    }
}
