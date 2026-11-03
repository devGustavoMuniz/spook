package limits

import "testing"

func TestDefaultsMatchSPEC(t *testing.T) {
	d := Default()
	if d.GuildsPerUser != 100 || d.AttachmentBytes != 25<<20 {
		t.Fatalf("padrões do SPEC 7.1/7.3: %+v", d)
	}
	if (Limits{}).Normalize() != d {
		t.Fatal("Limits{} deve valer o padrão")
	}
	if got := (Limits{ChannelsPerGuild: 7}).Normalize(); got.ChannelsPerGuild != 7 || got.RolesPerGuild != DefaultRolesPerGuild {
		t.Fatalf("campo preenchido é mantido: %+v", got)
	}
	if d.AttachmentMB() != 25 {
		t.Fatalf("MB: %d", d.AttachmentMB())
	}
}
