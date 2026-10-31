//! Conversões de quadros de vídeo: capturas (BGRA/RGBA) → I420 para o LiveKit, e I420 → RGB → JPEG para o
//! webview. Usa o libyuv do libwebrtc (rápido, SIMD) em vez de laços em Rust puro.

use jpeg_encoder::{ColorType, Encoder};
use libwebrtc::native::yuv_helper;
use libwebrtc::video_frame::native::VideoFrameBufferExt;
use libwebrtc::video_frame::{I420Buffer, VideoBuffer, VideoFormatType};

use super::limits::fit_within;

/// Ordem dos bytes de um pixel de 32 bits capturado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelOrder {
    /// B, G, R, A (macOS/Windows; também `BGRx` do PipeWire).
    Bgra,
    /// R, G, B, A (câmeras decodificadas; `RGBx` do PipeWire).
    Rgba,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("quadro vazio ou com dimensões inválidas")]
    Empty,
    #[error("buffer menor do que as dimensões declaradas")]
    ShortBuffer,
    #[error("falha ao codificar JPEG: {0}")]
    Jpeg(String),
}

/// Stride (bytes por linha) de um quadro de 32 bits, tolerando preenchimento no fim das linhas.
pub fn stride_of(len: usize, width: usize, height: usize) -> Option<usize> {
    if width == 0 || height == 0 {
        return None;
    }
    let min = width.checked_mul(4)?;
    if len < min.checked_mul(height)? {
        return None;
    }
    let s = len / height;
    Some(if s >= min { s } else { min })
}

/// Converte pixels de 32 bits para I420 (largura/altura pares, recortando 1 px se forem ímpares).
pub fn to_i420(
    data: &[u8],
    width: u32,
    height: u32,
    order: PixelOrder,
) -> Result<I420Buffer, FrameError> {
    let (w, h) = (width & !1, height & !1);
    if w == 0 || h == 0 {
        return Err(FrameError::Empty);
    }
    let stride =
        stride_of(data.len(), width as usize, height as usize).ok_or(FrameError::ShortBuffer)?;
    let mut out = I420Buffer::new(w, h);
    let (sy, su, sv) = out.strides();
    let (dy, du, dv) = out.data_mut();
    match order {
        // libyuv "ARGB" = bytes B,G,R,A na memória.
        PixelOrder::Bgra => yuv_helper::argb_to_i420(
            data,
            stride as u32,
            dy,
            sy,
            du,
            su,
            dv,
            sv,
            w as i32,
            h as i32,
        ),
        // libyuv "ABGR" = bytes R,G,B,A na memória.
        PixelOrder::Rgba => yuv_helper::abgr_to_i420(
            data,
            stride as u32,
            dy,
            sy,
            du,
            su,
            dv,
            sv,
            w as i32,
            h as i32,
        ),
    }
    Ok(out)
}

/// Reduz o I420 para caber em `max` (não amplia). Devolve o mesmo buffer se já couber.
pub fn fit_i420(mut buf: I420Buffer, max: (u32, u32)) -> I420Buffer {
    let (w, h) = (buf.width(), buf.height());
    let (nw, nh) = fit_within(w, h, max.0, max.1);
    if (nw, nh) == (w, h) {
        buf
    } else {
        buf.scale(nw as i32, nh as i32)
    }
}

/// I420 (ou qualquer buffer do libwebrtc) → JPEG, reduzido para caber em `max`. Devolve `(jpeg, w, h)`.
pub fn encode_jpeg(
    src: &dyn VideoBuffer,
    max: (u32, u32),
    quality: u8,
) -> Result<(Vec<u8>, u32, u32), FrameError> {
    let (sw, sh) = (src.width(), src.height());
    if sw < 2 || sh < 2 {
        return Err(FrameError::Empty);
    }
    let i420 = fit_i420(src.to_i420(), max);
    let (w, h) = (i420.width(), i420.height());
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    // libyuv "ABGR" = bytes R,G,B,A na memória.
    i420.to_argb(VideoFormatType::ABGR, &mut rgba, w * 4, w as i32, h as i32);
    let mut jpeg = Vec::with_capacity((w * h / 8) as usize);
    Encoder::new(&mut jpeg, quality)
        .encode(&rgba, w as u16, h as u16, ColorType::Rgba)
        .map_err(|e| FrameError::Jpeg(e.to_string()))?;
    Ok((jpeg, w, h))
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;

    /// I420 de duas metades: esquerda vermelha, direita azul.
    pub fn red_blue_i420(w: u32, h: u32) -> I420Buffer {
        let mut b = I420Buffer::new(w, h);
        let (sy, su, sv) = b.strides();
        let (y, u, v) = b.data_mut();
        for row in 0..h as usize {
            for col in 0..w as usize {
                y[row * sy as usize + col] = if col < w as usize / 2 { 82 } else { 41 };
            }
        }
        for row in 0..(h as usize / 2) {
            for col in 0..(w as usize / 2) {
                let red = col < w as usize / 4;
                u[row * su as usize + col] = if red { 90 } else { 240 };
                v[row * sv as usize + col] = if red { 240 } else { 110 };
            }
        }
        b
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::red_blue_i420;
    use super::*;

    fn decode(jpeg: &[u8]) -> image::RgbImage {
        image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)
            .expect("JPEG válido")
            .to_rgb8()
    }

    #[test]
    fn jpeg_has_the_expected_size_and_colors() {
        let src = red_blue_i420(640, 360);
        let (jpeg, w, h) = encode_jpeg(&src, (1280, 720), 80).unwrap();
        assert_eq!((w, h), (640, 360), "não amplia");
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        let img = decode(&jpeg);
        assert_eq!(img.dimensions(), (640, 360));
        let red = img.get_pixel(100, 180).0;
        let blue = img.get_pixel(540, 180).0;
        assert!(
            red[0] > 200 && red[1] < 60 && red[2] < 60,
            "vermelho: {red:?}"
        );
        assert!(blue[2] > 150 && blue[0] < 80, "azul: {blue:?}");
    }

    #[test]
    fn jpeg_is_downscaled_to_the_limit() {
        let src = red_blue_i420(2560, 1440);
        let (jpeg, w, h) = encode_jpeg(&src, (1280, 720), 70).unwrap();
        assert_eq!((w, h), (1280, 720));
        assert_eq!(decode(&jpeg).dimensions(), (1280, 720));
    }

    #[test]
    fn bgra_maps_channels_correctly() {
        // pixel B=0,G=0,R=255 (vermelho) em BGRA
        let (w, h) = (16u32, 16u32);
        let px = [0u8, 0, 255, 255];
        let data: Vec<u8> = px
            .iter()
            .copied()
            .cycle()
            .take((w * h * 4) as usize)
            .collect();
        let i420 = to_i420(&data, w, h, PixelOrder::Bgra).unwrap();
        let (jpeg, ..) = encode_jpeg(&i420, (64, 64), 90).unwrap();
        let p = decode(&jpeg).get_pixel(8, 8).0;
        assert!(p[0] > 200 && p[1] < 50 && p[2] < 50, "{p:?}");

        // o mesmo vermelho em RGBA
        let px = [255u8, 0, 0, 255];
        let data: Vec<u8> = px
            .iter()
            .copied()
            .cycle()
            .take((w * h * 4) as usize)
            .collect();
        let i420 = to_i420(&data, w, h, PixelOrder::Rgba).unwrap();
        let (jpeg, ..) = encode_jpeg(&i420, (64, 64), 90).unwrap();
        let p = decode(&jpeg).get_pixel(8, 8).0;
        assert!(p[0] > 200 && p[1] < 50 && p[2] < 50, "{p:?}");
    }

    #[test]
    fn to_i420_crops_odd_sizes_and_rejects_short_buffers() {
        let data = vec![0u8; 17 * 9 * 4];
        let b = to_i420(&data, 17, 9, PixelOrder::Bgra).unwrap();
        assert_eq!((b.width(), b.height()), (16, 8));
        assert_eq!(
            to_i420(&data[..100], 17, 9, PixelOrder::Bgra).err(),
            Some(FrameError::ShortBuffer)
        );
        assert_eq!(
            to_i420(&[], 0, 0, PixelOrder::Bgra).err(),
            Some(FrameError::Empty)
        );
    }

    #[test]
    fn stride_handles_row_padding() {
        assert_eq!(stride_of(16 * 4 * 8, 16, 8), Some(64));
        assert_eq!(stride_of(80 * 8, 16, 8), Some(80));
        assert_eq!(stride_of(10, 16, 8), None);
    }

    #[test]
    fn fit_i420_downscales_screen_to_1080p() {
        let b = I420Buffer::new_black(3840, 2160);
        let s = fit_i420(b, (1920, 1080));
        assert_eq!((s.width(), s.height()), (1920, 1080));
    }
}
