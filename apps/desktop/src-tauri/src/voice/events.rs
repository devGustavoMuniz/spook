//! Eventos da sala enviados ao webview (`tauri::ipc::Channel`). Espelham `VoiceEngineEvents` de
//! `apps/web/src/features/voice/engine.ts`; o JSON usa `type` em kebab-case e campos em camelCase.

use livekit::prelude::ConnectionQuality;
use livekit::DisconnectReason;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    /// `client` | `removed` | `network` | `unknown`.
    Disconnected {
        reason: &'static str,
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
        assert_eq!(
            serde_json::to_value(VoiceEvent::SpeakersChanged {
                identities: vec!["1".into()]
            })
            .unwrap()["identities"][0],
            "1"
        );
    }
}
