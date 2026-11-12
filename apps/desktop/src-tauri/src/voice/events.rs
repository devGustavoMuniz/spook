//! Eventos da sala enviados ao webview (`tauri::ipc::Channel`). Espelham `VoiceEngineEvents` de
//! `apps/web/src/features/voice/engine.ts`; o JSON usa `type` em kebab-case e campos em camelCase.

use livekit::prelude::ConnectionQuality;
use livekit::DisconnectReason;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum VoiceEvent {
    ParticipantJoined {
        identity: String,
    },
    ParticipantLeft {
        identity: String,
    },
    SpeakersChanged {
        identities: Vec<String>,
    },
    VideoTrackAdded {
        id: String,
        identity: String,
        /// `camera` | `screen`.
        kind: &'static str,
        local: bool,
    },
    VideoTrackRemoved {
        id: String,
    },
    /// `connecting` | `connected` | `reconnecting` | `disconnected`.
    ConnectionState {
        state: &'static str,
    },
    /// `excellent` | `good` | `poor` | `lost` | `unknown`.
    LinkQuality {
        quality: &'static str,
    },
    LocalMedia {
        microphone: bool,
        camera: bool,
        screen_share: bool,
    },
    DevicesChanged,
    /// A captura da MINHA tela está preta há alguns segundos (`black: true`) ou voltou ao normal (`false`).
    ScreenBlack {
        black: bool,
    },
    /// `client` | `removed` | `network` | `unknown`.
    Disconnected {
        reason: &'static str,
    },
    /// Medidor de nível do microfone (~20 por segundo): dBFS depois da supressão e da porta de ruído.
    InputLevel {
        db: f32,
        gate_open: bool,
    },
    /// O nível de ruído "Máximo" (DeepFilterNet) deixou de atender e o Forte (RNNoise) assumiu. `reason`: `cpu` (o
    /// processador não acompanhou) | `load-failed` | `unavailable` (build sem o modelo) | `error`. Sai no máximo
    /// uma vez por queda.
    NoiseSuppressionFallback {
        from: &'static str,
        to: &'static str,
        reason: &'static str,
    },
    /// Andamento do teste de microfone. `phase`: `requesting` | `recording` | `playing` | `done` | `error`;
    /// `error` (só em `error`): `permission-denied` | `not-found` | `in-use` | `unsupported` | `unknown`...
    MicTest {
        phase: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        remaining_ms: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'static str>,
    },
}

pub fn map_quality(q: ConnectionQuality) -> &'static str {
    match q {
        ConnectionQuality::Excellent => "excellent",
        ConnectionQuality::Good => "good",
        ConnectionQuality::Poor => "poor",
        ConnectionQuality::Lost => "lost",
    }
}

pub fn map_disconnect_reason(r: DisconnectReason) -> &'static str {
    match r {
        DisconnectReason::ClientInitiated => "client",
        DisconnectReason::ParticipantRemoved
        | DisconnectReason::RoomDeleted
        | DisconnectReason::RoomClosed
        | DisconnectReason::DuplicateIdentity => "removed",
        DisconnectReason::ServerShutdown
        | DisconnectReason::SignalClose
        | DisconnectReason::ConnectionTimeout
        | DisconnectReason::JoinFailure
        | DisconnectReason::MediaFailure
        | DisconnectReason::StateMismatch
        | DisconnectReason::Migration => "network",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disconnect_reasons_match_the_web_engine() {
        assert_eq!(
            map_disconnect_reason(DisconnectReason::ClientInitiated),
            "client"
        );
        for r in [
            DisconnectReason::ParticipantRemoved,
            DisconnectReason::RoomDeleted,
            DisconnectReason::RoomClosed,
            DisconnectReason::DuplicateIdentity,
        ] {
            assert_eq!(map_disconnect_reason(r), "removed");
        }
        for r in [
            DisconnectReason::ServerShutdown,
            DisconnectReason::SignalClose,
            DisconnectReason::ConnectionTimeout,
            DisconnectReason::JoinFailure,
            DisconnectReason::MediaFailure,
            DisconnectReason::StateMismatch,
            DisconnectReason::Migration,
        ] {
            assert_eq!(map_disconnect_reason(r), "network");
        }
        assert_eq!(
            map_disconnect_reason(DisconnectReason::UnknownReason),
            "unknown"
        );
    }

    #[test]
    fn quality_mapping() {
        assert_eq!(map_quality(ConnectionQuality::Lost), "lost");
        assert_eq!(map_quality(ConnectionQuality::Excellent), "excellent");
    }

    #[test]
    fn events_serialize_for_the_webview() {
        let v = serde_json::to_value(VoiceEvent::VideoTrackAdded {
            id: "TR_1".into(),
            identity: "42".into(),
            kind: "screen",
            local: false,
        })
        .unwrap();
        assert_eq!(v["type"], "video-track-added");
        assert_eq!(v["kind"], "screen");
        assert_eq!(v["local"], false);
        let v = serde_json::to_value(VoiceEvent::LocalMedia {
            microphone: true,
            camera: false,
            screen_share: true,
        })
        .unwrap();
        assert_eq!(v["type"], "local-media");
        assert_eq!(v["screenShare"], true);
        assert_eq!(
            serde_json::to_value(VoiceEvent::DevicesChanged).unwrap()["type"],
            "devices-changed"
        );
        let v = serde_json::to_value(VoiceEvent::InputLevel {
            db: -42.5,
            gate_open: true,
        })
        .unwrap();
        assert_eq!(v["type"], "input-level");
        assert_eq!(v["db"], -42.5);
        assert_eq!(v["gateOpen"], true);
        let v = serde_json::to_value(VoiceEvent::NoiseSuppressionFallback {
            from: "max",
            to: "strong",
            reason: "cpu",
        })
        .unwrap();
        assert_eq!(v["type"], "noise-suppression-fallback");
        assert_eq!(v["from"], "max");
        assert_eq!(v["to"], "strong");
        assert_eq!(v["reason"], "cpu");
        let v = serde_json::to_value(VoiceEvent::MicTest {
            phase: "recording",
            remaining_ms: Some(3200),
            error: None,
        })
        .unwrap();
        assert_eq!(v["type"], "mic-test");
        assert_eq!(v["phase"], "recording");
        assert_eq!(v["remainingMs"], 3200);
        assert!(v.get("error").is_none());
        let v = serde_json::to_value(VoiceEvent::MicTest {
            phase: "error",
            remaining_ms: None,
            error: Some("in-use"),
        })
        .unwrap();
        assert_eq!(v["error"], "in-use");
        assert!(v.get("remainingMs").is_none());
        assert_eq!(
            serde_json::to_value(VoiceEvent::SpeakersChanged {
                identities: vec!["1".into()]
            })
            .unwrap()["identities"][0],
            "1"
        );
    }
}
