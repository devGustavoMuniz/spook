# Fase 1 — Spook em produção (ao lado do baseline do Laravel)

**Status: REGISTRADO** (30/10/2026). Baseline do Laravel (antrax): [`fase-0-laravel-baseline.md`](./fase-0-laravel-baseline.md).
Critérios de produção da Fase 1 (SPEC): `/healthz` em produção ✅, k6 do baseline contra o Spook ✅, p95 de login ✅,
RAM ociosa ✅ (amostra única fornecida pelo dono), smoke de avatar ✅.

## Dois tipos de medição, lado a lado

Os números abaixo são **pela internet** (experiência do usuário, com Cloudflare e túnel no caminho). O método agora também inclui a
medição **interna** (backend, k6 na rede Docker do app no VPS, sem Cloudflare/túnel) e o header `Server-Timing` no Spook; ver
`bench/README.md`. Enquanto a medição interna não é rodada, as células ficam como _pendente_.

| Resultado (mediana de 3 rodadas) | Internet: Laravel | Internet: Spook | Interno: Laravel | Interno: Spook |
| --- | --- | --- | --- | --- |
| healthz p50 / p95 / p99 | 58,6 / 132,6 / 142,7 ms | 48,0 / 123,1 / 140,0 ms | _pendente_ | _pendente_ |
| login p50 / p95 / p99 | _pendente_ (sem conta de teste) | 110,7 / 177,7 / 190,0 ms (8/min) | _pendente_ | _pendente_ |
| Server-Timing `app` (processamento no backend) | n/a | _pendente_ (pós-deploy) | n/a | _pendente_ |
| Server-Timing `argon2` (hash) | n/a | _pendente_ (pós-deploy) | n/a | _pendente_ |

## Contexto
| Campo | Valor |
| --- | --- |
| Data/hora (com fuso) | 30/10/2026, 23:00:14 a 23:24:22 (UTC−03:00; 02:00:14 a 02:24:22 UTC) |
| Origem | Mac do dono (macOS, Darwin 25.3.0 arm64) executando o k6 em Docker Desktop (Docker 29.2.1); rede local do dono, fora do VPS |
| Versão do k6 | `grafana/k6:1.3.0` |
| Execução | `bench/scripts/run-alternating.sh`, 3 rodadas alternadas (antrax, Spook, antrax, Spook…), 20 s de pausa entre execuções |
| Carga (healthz) | `baseline.js`, `RATE=5` req/s por `DURATION=60s` (300 req por execução), carga leve por ser produção |
| Dados brutos | [`raw/2026-10-30-producao/`](./raw/2026-10-30-producao) (summary JSON e log de cada execução) |
| Alvo | `https://spook.dottadigital.com` (`/healthz`, `/api/auth/login`) |
| Imagem do Spook | `ghcr.io/devgustavomuniz/spook:1eb314dd5ab83d0ce1056f097b84eaab03edc67f` |

## 1. healthz — mesmo cenário do baseline (`baseline.js`, 5 req/s por 60 s)

### 1A. Internet (experiência do usuário) — mediana de 3 rodadas, medido em 30/10/2026

| Métrica | Laravel (antrax `/up`) | Spook (`/healthz`) |
| --- | --- | --- |
| http_reqs (por execução) / req/s | 301 / 5,01 | 301 / 5,01 |
| http_req_failed (mediana das rodadas) | 0,00% | 0,00% (ver nota sobre a rodada 2) |
| http_req_duration med (p50) | 58,6 ms | **48,0 ms** |
| http_req_duration p(95) | 132,6 ms | **123,1 ms** |
| http_req_duration p(99) | 142,7 ms | **140,0 ms** |
| http_req_duration avg | 70,8 ms | 66,0 ms |
| http_req_duration p(90) | 120,2 ms | 118,6 ms |
| http_req_duration max | 213,7 ms | 154,5 ms |

Leitura honesta: as diferenças (≈10 ms no p50 e no p95, ≈3 ms no p99) são **menores que a variação entre rodadas do próprio
sistema** (p50 do Spook foi de 30,9 a 53,1 ms; o do Laravel, de 52,3 a 70,1 ms). Os dois passam por Cloudflare + túnel, e este
endpoint mede sobretudo o caminho de rede. Conclusão válida: **equivalentes nesta medição**; a diferença de arquitetura só
aparece em cenários com trabalho de aplicação (Fase 2 em diante).

### Por rodada — Laravel
| Rodada | reqs | req/s | falhas | avg | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 300 | 5.00 | 0.00% (0) | 82.6 ms | 70.1 ms | 131.4 ms | 146.5 ms | 185.4 ms | 216.9 ms |
| 2 | 301 | 5.01 | 0.00% (0) | 70.8 ms | 58.6 ms | 120.2 ms | 128.8 ms | 136.1 ms | 146.1 ms |
| 3 | 301 | 5.01 | 0.00% (0) | 62.9 ms | 52.3 ms | 114.5 ms | 132.6 ms | 142.7 ms | 213.7 ms |
| **mediana** | 301 | 5.01 | 0.00% | 70.8 ms | 58.6 ms | 120.2 ms | 132.6 ms | 142.7 ms | 213.7 ms |

### Por rodada — Spook
| Rodada | reqs | req/s | falhas | avg | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 301 | 5.01 | 0.00% (0) | 67.4 ms | 53.1 ms | 119.1 ms | 123.5 ms | 140.0 ms | 154.5 ms |
| 2 | 301 | 5.01 | 1.33% (4) | 66.0 ms | 48.0 ms | 118.6 ms | 123.1 ms | 169.0 ms | 186.3 ms |
| 3 | 300 | 5.00 | 0.00% (0) | 43.9 ms | 30.9 ms | 95.7 ms | 107.0 ms | 119.3 ms | 137.2 ms |
| **mediana** | 301 | 5.01 | 0.00% | 66.0 ms | 48.0 ms | 118.6 ms | 123.1 ms | 140.0 ms | 154.5 ms |

**Nota — falhas na rodada 2 do Spook (1,33%, 4 de 301):** foram 4 erros `unexpected EOF` consecutivos em ~1 s, no fim da
execução (02:05:14–15 UTC); as rodadas 1 e 3 tiveram 0 falhas e o cenário de login (abaixo) ficou em 0% nas 126 requisições. É uma
conexão fechada no meio do caminho (borda da Cloudflare ↔ túnel), mas **a causa não foi investigada** por falta de acesso aos
logs do `cloudflared` no momento. Se reaparecer, vale olhar os logs do `cloudflared` nesse horário. A mediana de falhas
entre as rodadas é 0%, mas o dado bruto fica registrado aqui.

### 1B. Interno (backend, sem Cloudflare/túnel) — PENDENTE

Rodar `bench/scripts/run-internal.sh` (`bench/README.md`, seção 3). O `Server-Timing` do Spook só aparece depois do deploy do commit
que o introduziu.

| Métrica (mediana de 3 rodadas) | Laravel (antrax) | Spook |
| --- | --- | --- |
| http_req_duration p50 / p95 / p99 | _pendente_ | _pendente_ |
| Server-Timing `app` p50 / p95 / p99 | n/a (o antrax não expõe) | _pendente_ |
| http_req_failed | _pendente_ | _pendente_ |

## 2. Login

### 2A. Internet — Spook (`login.js`, 8 logins/min por 5 min, 3 rodadas, medido em 30/10/2026)

A taxa padrão do `login.js` mudou depois desta medição: agora é **4/min por 6 min**, igual à do antrax (que limita a 5/min por
e-mail+IP). Esta medição usou 8/min.

Cada rodada faz 41 logins (mais 1 cadastro no `setup`; por isso `reqs` = 42). `login_duration` mede **só** o `POST /api/auth/login`
(Argon2id incluído). A taxa fica abaixo do limite de 10/min por IP: houve 0 respostas 429.

| Métrica (mediana das 3 rodadas) | Spook |
| --- | --- |
| login_duration p50 | **110,7 ms** |
| login_duration p(95) | **177,7 ms** |
| login_duration p(99) | **190,0 ms** |
| login_duration avg | 119,5 ms |
| http_req_failed | 0,00% (0 falhas, 0 respostas 429) |

### Por rodada
| Rodada | reqs | req/s | falhas | avg | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 42 | 0.14 | 0.00% (0) | 120.9 ms | 111.9 ms | 164.4 ms | 187.1 ms | 215.4 ms | 226.4 ms |
| 2 | 42 | 0.14 | 0.00% (0) | 112.8 ms | 106.0 ms | 154.1 ms | 167.0 ms | 170.6 ms | 172.4 ms |
| 3 | 42 | 0.14 | 0.00% (0) | 119.5 ms | 110.7 ms | 168.7 ms | 177.7 ms | 190.0 ms | 194.7 ms |
| **mediana** | 42 | 0.14 | 0.00% | 119.5 ms | 110.7 ms | 164.4 ms | 177.7 ms | 190.0 ms | 194.7 ms |

Parte relevante desses ~110 ms é a rede (o piso do `/healthz` já é ~48 ms); o custo isolado do Argon2id (m=19 MiB, t=2, p=1) **não
foi medido** aqui. O Laravel não tem cenário de login equivalente medido (a comparação de login fica para um cenário comum aos
dois, se quisermos).

### 2B. Internet — antrax (`login-antrax.js`) — PENDENTE
Precisa de uma conta de teste existente, sem 2FA, no antrax. Rodar `run-alternating.sh` com `ANTRAX_LOGIN_EMAIL`/`ANTRAX_LOGIN_PASSWORD`.
Lembrete: o login do antrax tem **piso de ~200 ms** (Timebox), ver a seção "Login: algoritmo e custo de hash".

| Métrica (mediana de 3 rodadas) | Laravel | Spook |
| --- | --- | --- |
| login_duration p50 / p95 / p99 | _pendente_ | _pendente_ (a 4/min) |

### 2C. Interno (backend) — PENDENTE

| Métrica (mediana de 3 rodadas) | Laravel | Spook |
| --- | --- | --- |
| login_duration p50 / p95 / p99 | _pendente_ | _pendente_ |
| Server-Timing `app` p50 / p95 | n/a | _pendente_ |
| Server-Timing `argon2` p50 / p95 | n/a | _pendente_ |

## 3. Login: algoritmo e custo de hash

O hash domina a latência do login. Configuração de cada lado (lida do código) e custo medido **na mesma máquina**:

| | Spook | antrax (Laravel + Fortify) |
| --- | --- | --- |
| Algoritmo | **Argon2id** | **bcrypt** |
| Parâmetros | m = 19 456 KiB (19 MiB), t = 2, p = 1; salt 16 B, saída 32 B | custo (rounds) = **12** (`BCRYPT_ROUNDS=12`; `config/hashing.php` padrão do framework, driver `bcrypt`) |
| Onde está definido | `server/internal/auth/password.go` | `.env.prod.example` / padrão do Laravel; `rehash_on_login=true` |
| Uso de memória por hash | ~19 MiB (no máx. 4 simultâneos, por semáforo) | ~4 KiB (bcrypt não é memory-hard) |
| Tempo constante contra enumeração | hash "fantasma" quando o e-mail não existe | **`Timebox` de 200 ms**: todo login leva **≥ ~200 ms** |
| Limite de tentativas | 10/min por IP (`/api/auth/*`) | 5/min por e-mail+IP |
| **Custo medido** (hash / verify, mediana de 20) | **23,6 / 24,2 ms** (Go, `x/crypto/argon2`) | **209,3 / 209,5 ms** (PHP 8.4, `password_hash`) |

Medido em 30/10/2026 no Mac do dono (arm64, Docker Desktop, mesma VM Linux para os dois): `go test -bench` em `server/internal/auth` e
`bench/scripts/hash-cost.php`. Outros pontos da mesma execução: bcrypt custo 10 = 52,2 ms e custo 13 = 421,9 ms; **Argon2id com os
parâmetros do Spook na libargon2 do PHP = 14,5 / 14,0 ms**; Argon2id com o padrão do Laravel (64 MiB, t=4) = 135,4 ms (verify).

Como ler isto:
- Nesta máquina o **bcrypt 12 custa ≈ 8,6× o Argon2id do Spook em Go** e ≈ 15× o mesmo Argon2id na libargon2. A latência do login
  compara *configurações* (custo escolhido), não só linguagens ou frameworks.
- **Ressalva do Go:** o `golang.org/x/crypto/argon2` tem otimização em assembly para amd64 e usa código genérico em arm64; este Mac é
  arm64, por isso o Go aparece mais lento que a libargon2 aqui (24 contra 14 ms). No VPS o número que vale é o `argon2` do
  **Server-Timing** (pendente de medição pós-deploy). Não extrapole estes 24 ms para o VPS.
- **Custo não é igual a segurança equivalente.** O Spook usa o mínimo recomendado pela OWASP para Argon2id (19 MiB, t=2, p=1); o
  antrax usa bcrypt 12 (a OWASP pede custo ≥ 10). Para comparar *implementações* em pé de igualdade, o caminho é calibrar os dois para o
  mesmo tempo-alvo (por exemplo ~50 ms: bcrypt 10 contra o Argon2id atual); isso é uma decisão do dono, não feita aqui.
- No antrax o `Timebox` faz o login nunca ser mais rápido que ~200 ms, mesmo que o hash seja barato. Com o bcrypt 12 medido aqui (≈ 209 ms),
  o hash sozinho já passa do piso; no VPS depende da CPU.

## 4. RAM ociosa — `docker stats --no-stream` no VPS, 30/10/2026, **amostra única** (fornecida pelo dono)

| Stack Spook | MiB | | Stack Antrax | MiB |
| --- | --- | --- | --- | --- |
| **spook (backend)** | **21,57** | | app | 74,23 |
| postgres | 34,13 | | reverb | 56,98 |
| livekit | 38,40 | | queue | 53,89 |
| cloudflared | 29,86 | | scheduler | 51,56 |
| garage | 11,13 | | **backend (soma)** | **236,66** |
| | | | postgres | 134,60 |
| | | | livekit | 62,05 |
| | | | cloudflared | 31,93 |
| | | | redis | 7,62 |
| | | | site | 3,75 |
| | | | edge | 3,54 |
| **Stack Spook** | **≈ 135 MiB** | | **Stack Antrax** | **≈ 480 MiB** |

- Meta do SPEC (RNF01): RAM ociosa do backend < 100 MB → **21,57 MiB** ✅ (nesta amostra).
- Backend a backend: Spook 21,57 MiB contra 236,66 MiB do Laravel (app + reverb + queue + scheduler); stack inteira ≈ 135 contra ≈ 480 MiB.
- **Ressalvas (leia antes de citar estes números):** (1) o Spook só tem auth: ainda não há gateway WebSocket nem jobs, então o
  backend vai crescer; (2) o Antrax roda há dias, com dados e uso real, o que infla caches e processos; (3) é uma **única
  amostra**. Para as próximas medições use `bench/scripts/docker-stats.sh` (mediana de N amostras).

## 5. Smoke do avatar em produção (README do deploy, seção 6.3)
`node scripts/smoke-prod.mjs https://spook.dottadigital.com` → **19 verificações, todas OK** (saída: [`raw/2026-10-30-producao/smoke-avatar.txt`](./raw/2026-10-30-producao/smoke-avatar.txt)):
cadastro (cookie `HttpOnly; Secure; SameSite=Lax`), logout, 401 sem sessão, login, URL pré-assinada apontando para
`spook-files.dottadigital.com`, **preflight CORS a partir de `https://spook.dottadigital.com` com 200 e `Allow-Origin` correto**
(origem estranha recebe 403), **PUT direto no storage com 200 e sem `SignatureDoesNotMatch`** (o `Host` público chega intacto ao
Garage), PATCH do perfil, GET pré-assinado devolvendo os mesmos bytes (`sha256` idêntico) com `Content-Type: image/png`, e as recusas
422 (tipo inválido e chave de avatar de outro usuário).

## Usuários de teste que ficaram no banco de produção
Não existe rota de excluir conta; a remoção, se desejada, é feita direto no banco (ex.: `DELETE FROM users WHERE email LIKE '%@bench.spook.invalid' OR email LIKE '%@smoke.spook.invalid'`; as sessões saem por `ON DELETE CASCADE`).

| Origem | username | e-mail |
| --- | --- | --- |
| login.js, rodada 1 | `bench_179341249958983236` | `bench-179341249958983236@bench.spook.invalid` |
| login.js, rodada 2 | `bench_1793412820720981905` | `bench-1793412820720981905@bench.spook.invalid` |
| login.js, rodada 3 | `bench_1793413141679679198` | `bench-1793413141679679198@bench.spook.invalid` |
| smoke do avatar | `smoke_1793413483314` | `smoke-1793413483314@smoke.spook.invalid` |

O avatar do `smoke_1793413483314` fica no bucket (`avatars/109839944519778304/109839946059087872.png`, 70 bytes).
