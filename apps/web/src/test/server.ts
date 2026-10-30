import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export type FakeUser = {
  id: string;
  email: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  created_at: string;
};

export const sampleUser: FakeUser = {
  id: "1",
  email: "ana@spook.dev",
  username: "ana",
  created_at: "2026-10-30T12:00:00Z",
};

const problem = (status: number, detail: string, errors: unknown[] = []) =>
  HttpResponse.json({ title: String(status), status, detail, errors }, { status });

/** Backend falso em memória: o cookie vira uma flag `signedIn`. */
export function makeBackend(initial: { signedIn?: boolean } = {}) {
  const state = {
    signedIn: initial.signedIn ?? false,
    user: { ...sampleUser },
    patches: [] as unknown[],
    logouts: 0,
  };

  const handlers = [
    http.get("*/api/users/me", () =>
      state.signedIn ? HttpResponse.json(state.user) : problem(401, "autenticação necessária"),
    ),
    http.post("*/api/auth/login", async ({ request }) => {
      const b = (await request.json()) as { email: string; password: string };
      if (b.password !== "senha-correta-1") return problem(401, "e-mail ou senha incorretos");
      state.signedIn = true;
      return HttpResponse.json({ user: state.user });
    }),
    http.post("*/api/auth/register", async ({ request }) => {
      const b = (await request.json()) as { email: string; username: string };
      if (b.email === sampleUser.email) return problem(409, "e-mail já cadastrado");
      if (b.username === "ocupado") return problem(409, "nome de usuário já em uso");
      state.signedIn = true;
      state.user = { ...sampleUser, email: b.email, username: b.username };
      return HttpResponse.json({ user: state.user }, { status: 201 });
    }),
    http.post("*/api/auth/logout", () => {
      state.logouts++;
      state.signedIn = false;
      return new HttpResponse(null, { status: 204 });
    }),
    http.patch("*/api/users/me", async ({ request }) => {
      const b = (await request.json()) as { display_name?: string };
      state.patches.push(b);
      if (b.display_name !== undefined)
        state.user = { ...state.user, display_name: b.display_name || undefined };
      return HttpResponse.json(state.user);
    }),
  ];
  return { state, handlers };
}

export const server = setupServer();
