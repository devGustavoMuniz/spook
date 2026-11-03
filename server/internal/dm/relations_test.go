package dm

import (
	"context"
	"slices"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// fakeRelations: amigos e bloqueios (em qualquer sentido) por par ordenado.
type fakeRelations struct{ friends, blocked map[[2]int64]bool }

func (f fakeRelations) pick(m map[[2]int64]bool, u int64, cands []int64) []int64 {
	var out []int64
	for _, c := range cands {
		if m[key(u, c)] {
			out = append(out, c)
		}
	}
	return out
}

func (f fakeRelations) FriendsAmong(_ context.Context, u int64, c []int64) ([]int64, error) {
	return f.pick(f.friends, u, c), nil
}

func (f fakeRelations) BlockedAmong(_ context.Context, u int64, c []int64) ([]int64, error) {
	return f.pick(f.blocked, u, c), nil
}

func TestOpenAllowsFriendsWithoutSharedGuild(t *testing.T) {
	s, _, _, _ := setup()
	rel := fakeRelations{friends: map[[2]int64]bool{key(1, 2): true}, blocked: map[[2]int64]bool{}}
	s.SetRelations(rel)
	if _, created, err := s.Open(ctx, 1, 2); err != nil || !created {
		t.Fatalf("amigos sem servidor em comum: %v %v", created, err)
	}
	if _, _, err := s.Open(ctx, 1, 3); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("sem servidor nem amizade: %v", err)
	}
}

func TestBlockPreventsOpenInBothDirectionsWithSameError(t *testing.T) {
	s, st, _, _ := setup()
	st.share(1, 2) // compartilham servidor: sem bloqueio a DM abre
	rel := fakeRelations{friends: map[[2]int64]bool{}, blocked: map[[2]int64]bool{key(1, 2): true}}
	s.SetRelations(rel)
	_, _, e1 := s.Open(ctx, 1, 2)
	_, _, e2 := s.Open(ctx, 2, 1)
	_, _, e3 := s.Open(ctx, 1, 3) // sem relação nenhuma
	for _, err := range []error{e1, e2, e3} {
		if !apperr.IsKind(err, apperr.KindForbidden) {
			t.Fatalf("esperado 403: %v", err)
		}
	}
	if e1.Error() != e2.Error() || e1.Error() != e3.Error() {
		t.Fatalf("o erro não pode diferenciar o bloqueio: %q %q %q", e1, e2, e3)
	}
	// Grupo: um bloqueado entre os convidados do criador impede a criação; um bloqueio entre convidados não.
	st.share(1, 4)
	st.share(1, 5)
	rel.blocked[key(1, 5)] = true
	if _, err := s.CreateGroup(ctx, 1, []int64{4, 5}); !apperr.IsKind(err, apperr.KindForbidden) {
		t.Fatalf("grupo com bloqueado: %v", err)
	}
	st.share(1, 6)
	rel.blocked[key(4, 6)] = true
	if _, err := s.CreateGroup(ctx, 1, []int64{4, 6}); err != nil {
		t.Fatalf("bloqueio entre convidados não impede o grupo: %v", err)
	}
	_ = slices.Contains[[]int64]
}
