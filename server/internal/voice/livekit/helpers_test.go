package livekit

import (
	"encoding/json"

	"github.com/livekit/protocol/utils/protojson"
	"google.golang.org/protobuf/proto"
)

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

func protojsonMarshal(m proto.Message) ([]byte, error) { return protojson.Marshal(m) }
