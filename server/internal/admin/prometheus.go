package admin

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// PromClient lê o endpoint Prometheus do LiveKit (rede interna do Compose) e o traduz em MediaSample.
// Só valores que o LiveKit expõe entram; o resto fica nulo.
type PromClient struct {
	URL  string
	HTTP *http.Client
}

var _ MediaMetrics = (*PromClient)(nil)

func NewPromClient(url string) *PromClient {
	return &PromClient{URL: url, HTTP: &http.Client{Timeout: 3 * time.Second}}
}

func (c *PromClient) Fetch(ctx context.Context) (MediaSample, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL, nil)
	if err != nil {
		return MediaSample{}, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return MediaSample{}, fmt.Errorf("consultar métricas do LiveKit: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return MediaSample{}, fmt.Errorf("métricas do LiveKit: status %d", resp.StatusCode)
	}
	return ParseMedia(io.LimitReader(resp.Body, 8<<20))
}

type promSample struct {
	name   string
	labels string // o texto entre chaves, sem parsear
	value  float64
}

func parseProm(r io.Reader) ([]promSample, error) {
	var out []promSample
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' {
			continue
		}
		name, rest := line, ""
		labels := ""
		if i := strings.IndexByte(line, '{'); i >= 0 {
			j := strings.LastIndexByte(line, '}')
			if j < i {
				continue
			}
			name, labels, rest = line[:i], line[i+1:j], line[j+1:]
		} else if i := strings.IndexByte(line, ' '); i >= 0 {
			name, rest = line[:i], line[i:]
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		v, err := strconv.ParseFloat(f[0], 64)
		if err != nil {
			continue
		}
		out = append(out, promSample{name: name, labels: labels, value: v})
	}
	return out, sc.Err()
}

func sumOf(ss []promSample, name string, labelContains ...string) (float64, bool) {
	var total float64
	found := false
outer:
	for _, s := range ss {
		if s.name != name {
			continue
		}
		for _, l := range labelContains {
			if !strings.Contains(s.labels, l) {
				continue outer
			}
		}
		total += s.value
		found = true
	}
	return total, found
}

// histAvg devolve a média de um histograma (soma/contagem) somando todas as séries.
func histAvg(ss []promSample, name string) *float64 {
	sum, ok1 := sumOf(ss, name+"_sum")
	cnt, ok2 := sumOf(ss, name+"_count")
	if !ok1 || !ok2 || cnt == 0 {
		return nil
	}
	v := sum / cnt
	return &v
}

// ParseMedia interpreta o texto Prometheus do LiveKit. Nomes usados (livekit-server): livekit_room_total,
// livekit_participant_total, livekit_track_published_total, livekit_track_subscribed_total,
// livekit_packet_total / livekit_packet_bytes (direction="incoming|outgoing"), livekit_packet_loss_total,
// e os histogramas livekit_jitter_us, livekit_rtt_ms e livekit_quality_score.
func ParseMedia(r io.Reader) (MediaSample, error) {
	ss, err := parseProm(r)
	if err != nil {
		return MediaSample{}, err
	}
	var m MediaSample
	m.Rooms, _ = sumOf(ss, "livekit_room_total")
	m.Participants, _ = sumOf(ss, "livekit_participant_total")
	m.TracksPublished, _ = sumOf(ss, "livekit_track_published_total")
	m.TracksSubs, _ = sumOf(ss, "livekit_track_subscribed_total")
	m.BytesIn, _ = sumOf(ss, "livekit_packet_bytes", `direction="incoming"`)
	m.BytesOut, _ = sumOf(ss, "livekit_packet_bytes", `direction="outgoing"`)
	m.PacketsIn, _ = sumOf(ss, "livekit_packet_total", `direction="incoming"`)
	m.PacketsOut, _ = sumOf(ss, "livekit_packet_total", `direction="outgoing"`)
	if m.PacketsIn+m.PacketsOut == 0 { // versões que só expõem o contador por nó
		m.PacketsIn, _ = sumOf(ss, "livekit_node_packet_total", `type="in"`)
		m.PacketsOut, _ = sumOf(ss, "livekit_node_packet_total", `type="out"`)
	}
	if lost, ok := sumOf(ss, "livekit_packet_loss_total"); ok {
		if total := m.PacketsIn + m.PacketsOut + lost; total > 0 {
			p := lost / total * 100
			m.PacketLossPct = &p
		}
	}
	if j := histAvg(ss, "livekit_jitter_us"); j != nil {
		ms := *j / 1000
		m.JitterMs = &ms
	}
	m.RTTMs = histAvg(ss, "livekit_rtt_ms")
	m.QualityScore = histAvg(ss, "livekit_quality_score")
	return m, nil
}
