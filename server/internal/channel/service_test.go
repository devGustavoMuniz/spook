package channel

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

type recorder struct {
	mu  sync.Mutex
	evs []events.Event
}

func (r *recorder) Publish(e events.Event) { r.mu.Lock(); r.evs = append(r.evs, e); r.mu.Unlock() }

func (r *recorder) types() []string {
	var out []string
	for _, e := range r.evs {
		out = append(out, e.Type)
	}
	return out
}

type fakeStore struct{ chans map[int64]Channel }

func (f *fakeStore) Create(_ context.Context, c Channel) (Channel, error) {
	f.chans[c.ID] = c
	return c, nil
}
func (f *fakeStore) Get(_ context.Context, id int64) (Channel, error) {
	c, ok := f.chans[id]
	if !ok {
		return Channel{}, ErrNotFound
	}
	return c, nil
}
func (f *fakeStore) ListByGuild(_ context.Context, guildID int64) ([]Channel, error) {
	var out []Channel
	for _, c := range f.chans {
		if c.GuildID != nil && *c.GuildID == guildID {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
func (f *fakeStore) ListByGuilds(context.Context, []int64) (map[int64][]Channel, error) {
	return nil, nil
}
func (f *fakeStore) NextPosition(_ context.Context, guildID int64) (int32, error) {
	cs, _ := f.ListByGuild(context.Background(), guildID)
	return int32(len(cs)), nil
}
func (f *fakeStore) Update(_ context.Context, id int64, name string, pos int32) (Channel, error) {
	c := f.chans[id]
	c.Name, c.Position = name, pos
	f.chans[id] = c
	return c, nil
}
func (f *fakeStore) UpdatePlacements(_ context.Context, _ int64, ps []Placement) error {
	for _, p := range ps {
		c := f.chans[p.ID]
		c.Position, c.ParentID = p.Position, p.ParentID
		f.chans[p.ID] = c
	}
	return nil
}
func (f *fakeStore) Delete(_ context.Context, id int64) error {
	delete(f.chans, id)
	for k, c := range f.chans { // ON DELETE SET NULL
		if c.ParentID != nil && *c.ParentID == id {
			c.ParentID = nil
			f.chans[k] = c
		}
	}
	return nil
}

type fakeAccess struct {
	members map[int64]perm.Member // userID -> membro do servidor 1
}

func (f fakeAccess) Member(_ context.Context, _, userID int64) (perm.Member, error) {
	m, ok := f.members[userID]
	if !ok {
		return perm.Member{}, perm.ErrNotMember
	}
	return m, nil
}

type seq struct{ n int64 }

func (s *seq) Next() int64 { s.n++; return 100 + s.n }

const (
	owner, plain, stranger = 1, 2, 3
	guildID                = int64(1)
)

func setup() (*Service, *fakeStore, *recorder) {
	g := guildID
	cat, text, voice := int64(10), int64(11), int64(12)
	st := &fakeStore{chans: map[int64]Channel{
		cat:   {ID: cat, Type: TypeCategory, GuildID: &g, Name: "Canais"},
		text:  {ID: text, Type: TypeText, GuildID: &g, ParentID: &cat, Name: "geral"},
		voice: {ID: voice, Type: TypeVoice, GuildID: &g, ParentID: &cat, Name: "Geral", Position: 1},
		50:    {ID: 50, Type: TypeText, GuildID: func() *int64 { x := int64(2); return &x }(), Name: "de-outro-servidor"},
		60:    {ID: 60, Type: TypeDM},
	}}
	acc := fakeAccess{members: map[int64]perm.Member{
		owner: perm.NewMember(owner, true, 0, 0),
		plain: perm.NewMember(plain, false, perm.DefaultEveryone, 0),
	}}
	rec := &recorder{}
	return NewService(st, acc, &seq{}, rec), st, rec
}

func TestCreatePermissionsAndValidation(t *testing.T) {
	cat := int64(10)
	text := int64(11)
	tests := []struct {
		name string
		user int64
		in   CreateParams
		want error // nil = sucesso
		kind apperr.Kind
	}{
		{"dono cria texto", owner, CreateParams{Type: TypeText, Name: "novo"}, nil, 0},
		{"dono cria voz em categoria", owner, CreateParams{Type: TypeVoice, Name: "Sala", ParentID: &cat}, nil, 0},
		{"dono cria categoria", owner, CreateParams{Type: TypeCategory, Name: "Nova"}, nil, 0},
		{"membro sem MANAGE_CHANNELS", plain, CreateParams{Type: TypeText, Name: "x"}, ErrForbidden, 0},
		{"não-membro vê servidor inexistente", stranger, CreateParams{Type: TypeText, Name: "x"}, nil, apperr.KindNotFound},
		{"tipo DM não entra", owner, CreateParams{Type: TypeDM, Name: "x"}, nil, apperr.KindInvalid},
		{"nome vazio", owner, CreateParams{Type: TypeText, Name: "   "}, nil, apperr.KindInvalid},
		{"nome grande", owner, CreateParams{Type: TypeText, Name: string(make([]byte, 101))}, nil, apperr.KindInvalid},
		{"pai que não é categoria", owner, CreateParams{Type: TypeText, Name: "x", ParentID: &text}, nil, apperr.KindInvalid},
		{"categoria dentro de categoria", owner, CreateParams{Type: TypeCategory, Name: "x", ParentID: &cat}, nil, apperr.KindInvalid},
		{"pai inexistente", owner, CreateParams{Type: TypeText, Name: "x", ParentID: ptr(999)}, nil, apperr.KindInvalid},
		{"pai de outro servidor", owner, CreateParams{Type: TypeText, Name: "x", ParentID: ptr(50)}, nil, apperr.KindInvalid},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, _, rec := setup()
			c, err := svc.Create(context.Background(), tt.user, guildID, tt.in)
			switch {
			case tt.want != nil:
				if !errors.Is(err, tt.want) {
					t.Fatalf("esperava %v, veio %v", tt.want, err)
				}
			case tt.kind != 0:
				if !apperr.IsKind(err, tt.kind) {
					t.Fatalf("esperava erro do tipo %d, veio %v", tt.kind, err)
				}
			default:
				if err != nil || c.ID == 0 {
					t.Fatalf("esperava sucesso: %v", err)
				}
				if got := rec.types(); len(got) != 1 || got[0] != events.ChannelCreate {
					t.Fatalf("eventos: %v", got)
				}
				ev := rec.evs[0]
				if ev.GuildID != guildID || ev.ChannelID != c.ID || ev.Topics[0] != "guild:1" {
					t.Fatalf("evento: %+v", ev)
				}
				return
			}
			if len(rec.evs) != 0 {
				t.Fatalf("falha não deve publicar: %v", rec.types())
			}
		})
	}
}

func ptr(v int64) *int64 { return &v }

func TestAuthorize(t *testing.T) {
	svc, _, _ := setup()
	ctx := context.Background()
	if _, _, err := svc.Authorize(ctx, owner, 11, perm.SendMessages); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Authorize(ctx, stranger, 11, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("não-membro: %v", err)
	}
	if _, _, err := svc.Authorize(ctx, plain, 999, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("canal inexistente: %v", err)
	}
	if _, _, err := svc.Authorize(ctx, owner, 60, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DM ainda não é suportada aqui: %v", err)
	}
	if _, _, err := svc.Authorize(ctx, plain, 11, perm.ManageMessages); !errors.Is(err, ErrForbidden) {
		t.Fatalf("sem permissão: %v", err)
	}
}

func TestUpdateAndDeleteEmitEvents(t *testing.T) {
	svc, st, rec := setup()
	ctx := context.Background()
	name := "renomeado"
	if _, err := svc.Update(ctx, plain, 11, UpdateParams{Name: &name}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("membro: %v", err)
	}
	if _, err := svc.Update(ctx, stranger, 11, UpdateParams{Name: &name}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("não-membro: %v", err)
	}
	if c, err := svc.Update(ctx, owner, 11, UpdateParams{Name: &name}); err != nil || c.Name != name {
		t.Fatalf("update: %v %v", c, err)
	}
	// excluir a categoria solta os filhos e avisa cada um
	rec.evs = nil
	if err := svc.Delete(ctx, owner, 10); err != nil {
		t.Fatal(err)
	}
	got := rec.types()
	if len(got) != 3 || got[0] != events.ChannelDelete || got[1] != events.ChannelUpdate || got[2] != events.ChannelUpdate {
		t.Fatalf("eventos: %v", got)
	}
	if st.chans[11].ParentID != nil {
		t.Fatal("filho deveria ter ficado sem categoria")
	}
	if err := svc.Delete(ctx, owner, 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("excluir de novo: %v", err)
	}
	if err := svc.Delete(ctx, owner, 60); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DM não se exclui aqui: %v", err)
	}
}

func TestReorderValidation(t *testing.T) {
	cat, text := int64(10), int64(11)
	tests := []struct {
		name string
		ps   []Placement
		user int64
		ok   bool
	}{
		{"válido", []Placement{{ID: text, Position: 3, ParentID: nil}, {ID: 12, Position: 0, ParentID: &cat}}, owner, true},
		{"vazio", nil, owner, true},
		{"sem permissão", []Placement{{ID: text}}, plain, false},
		{"canal de outro servidor", []Placement{{ID: 50}}, owner, false},
		{"repetido", []Placement{{ID: text}, {ID: text, Position: 1}}, owner, false},
		{"posição negativa", []Placement{{ID: text, Position: -1}}, owner, false},
		{"categoria com pai", []Placement{{ID: cat, ParentID: &cat}}, owner, false},
		{"pai não é categoria", []Placement{{ID: 12, ParentID: &text}}, owner, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, st, rec := setup()
			out, err := svc.Reorder(context.Background(), tt.user, guildID, tt.ps)
			if !tt.ok {
				if err == nil || len(rec.evs) != 0 {
					t.Fatalf("esperava erro sem eventos: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(out) != 3 || len(rec.evs) != len(tt.ps) {
				t.Fatalf("saída %d canais, %d eventos", len(out), len(rec.evs))
			}
			if len(tt.ps) > 0 && st.chans[text].Position != 3 {
				t.Fatalf("posição não aplicada: %+v", st.chans[text])
			}
		})
	}
}

type fakeDMs struct {
	recipients map[[2]int64]bool // (canal, usuário)
	renamed    []string
	err        error
}

func (f *fakeDMs) IsRecipient(_ context.Context, ch, u int64) (bool, error) {
	return f.recipients[[2]int64{ch, u}], f.err
}

func (f *fakeDMs) Rename(_ context.Context, _, ch int64, name string) (Channel, error) {
	f.renamed = append(f.renamed, name)
	return Channel{ID: ch, Type: TypeGroupDM, Name: name}, nil
}

func TestAuthorizeDM(t *testing.T) {
	svc, st, _ := setup()
	st.chans[61] = Channel{ID: 61, Type: TypeGroupDM}
	dms := &fakeDMs{recipients: map[[2]int64]bool{{60, plain}: true, {61, plain}: true}}
	svc.SetDMs(dms)
	ctx := context.Background()

	ch, m, err := svc.Authorize(ctx, plain, 60, perm.SendMessages|perm.ManageMessages)
	if err != nil || ch.ID != 60 || ch.GuildID != nil || m.Has(perm.ManageMessages) {
		t.Fatalf("participante: ch=%+v m=%+v err=%v", ch, m, err)
	}
	if _, _, err := svc.Authorize(ctx, plain, 61, 0); err != nil {
		t.Fatalf("DM em grupo: %v", err)
	}
	if _, _, err := svc.Authorize(ctx, stranger, 60, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("quem não participa recebe 404, veio %v", err)
	}
	dms.err = errors.New("banco fora")
	if _, _, err := svc.Authorize(ctx, plain, 60, 0); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("falha do banco não vira 404: %v", err)
	}
}

func TestUpdateDMGoesThroughGroupRename(t *testing.T) {
	svc, st, _ := setup()
	st.chans[61] = Channel{ID: 61, Type: TypeGroupDM}
	dms := &fakeDMs{recipients: map[[2]int64]bool{{60, plain}: true, {61, plain}: true}}
	svc.SetDMs(dms)
	ctx := context.Background()
	name, pos := "Estudos", int32(3)

	c, err := svc.Update(ctx, plain, 61, UpdateParams{Name: &name})
	if err != nil || c.Name != "Estudos" || len(dms.renamed) != 1 {
		t.Fatalf("c=%+v err=%v renamed=%v", c, err, dms.renamed)
	}
	if _, err := svc.Update(ctx, plain, 61, UpdateParams{Name: &name, Position: &pos}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("posição não se aplica a DM: %v", err)
	}
	if _, err := svc.Update(ctx, plain, 60, UpdateParams{Name: &name}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("DM 1:1 não tem nome: %v", err)
	}
	if _, err := svc.Update(ctx, stranger, 61, UpdateParams{Name: &name}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("não participante: %v", err)
	}
	if _, err := svc.Update(ctx, plain, 61, UpdateParams{}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("sem nome: %v", err)
	}
	if len(dms.renamed) != 1 {
		t.Fatal("só o primeiro PATCH deveria renomear")
	}
	// canais de servidor seguem as regras de antes
	if _, err := svc.Update(ctx, plain, 11, UpdateParams{Name: &name}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("canal de servidor sem MANAGE_CHANNELS: %v", err)
	}
}

func TestDMPayloadHasRecipientsAndServerChannelDoesNot(t *testing.T) {
	owner := int64(1)
	dm := Channel{ID: 5, Type: TypeGroupDM, OwnerID: &owner, Name: "g", Recipients: []Recipient{{ID: 1, Username: "a"}, {ID: 2, Username: "b"}}}
	p := dm.Payload()
	if p.OwnerID == nil || *p.OwnerID != "1" || len(p.Recipients) != 2 || p.Recipients[1].ID != "2" || p.GuildID != nil {
		t.Fatalf("payload da DM: %+v", p)
	}
	g := int64(1)
	sp := Channel{ID: 6, Type: TypeText, GuildID: &g}.Payload()
	if sp.OwnerID != nil || sp.Recipients != nil {
		t.Fatalf("canal de servidor não leva campos de DM: %+v", sp)
	}
}
