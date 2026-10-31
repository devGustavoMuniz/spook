//! Formato binário do quadro de vídeo enviado ao webview (sem base64):
//!
//! ```text
//! [u32 little-endian: tamanho N do cabeçalho][N bytes: JSON UTF-8][bytes do JPEG]
//! ```
//!
//! O cabeçalho é `{trackId, participantId, source, width, height, timestamp}`; `timestamp` é o instante da
//! codificação em milissegundos desde a época Unix. O decodificador espelho está em
//! `apps/web/src/desktop/frame-wire.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameHeader {
    pub track_id: String,
    pub participant_id: String,
    /// `camera` ou `screen`.
    pub source: String,
    pub width: u32,
    pub height: u32,
    pub timestamp: u64,
}

pub fn encode(header: &FrameHeader, jpeg: &[u8]) -> Vec<u8> {
    // Serializar uma struct de campos simples não falha; o fallback vazio evita um `unwrap`.
    let json = serde_json::to_vec(header).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + json.len() + jpeg.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(jpeg);
    out
}

pub fn decode(bytes: &[u8]) -> Option<(FrameHeader, &[u8])> {
    let n = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let json = bytes.get(4..4usize.checked_add(n)?)?;
    let header = serde_json::from_slice(json).ok()?;
    Some((header, &bytes[4 + n..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> FrameHeader {
        FrameHeader {
            track_id: "TR_1".into(),
            participant_id: "42".into(),
            source: "screen".into(),
            width: 1280,
            height: 720,
            timestamp: 1_700_000_000_123,
        }
    }

    #[test]
    fn roundtrip() {
        let jpeg = [0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9];
        let bytes = encode(&header(), &jpeg);
        let (h, body) = decode(&bytes).expect("decodifica");
        assert_eq!(h, header());
        assert_eq!(body, jpeg);
    }

    #[test]
    fn header_uses_camel_case_keys() {
        let bytes = encode(&header(), &[]);
        let n = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        let v: serde_json::Value = serde_json::from_slice(&bytes[4..4 + n]).unwrap();
        for k in [
            "trackId",
            "participantId",
            "source",
            "width",
            "height",
            "timestamp",
        ] {
            assert!(v.get(k).is_some(), "falta {k}");
        }
    }

    #[test]
    fn rejects_truncated_input() {
        assert!(decode(&[]).is_none());
        assert!(decode(&[9, 0, 0, 0, 1]).is_none());
        assert!(decode(&[255, 255, 255, 255]).is_none());
    }
}
