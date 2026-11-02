import { Bell, Copy, Download, Mic, Plus, Search, Settings, Trash2, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import {
  EmptyChatIllustration,
  NotFoundIllustration,
  VoiceInviteIllustration,
} from "@/components/illustrations";
import { useTheme } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Avatar, avatarSizes } from "@/components/ui/avatar";
import { Badge, CountBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Referência interna dos componentes. Só existe com `import.meta.env.DEV` (veja router.tsx):
// o build de produção não inclui esta página. Documentação: docs/design/DESIGN-SYSTEM.md.

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="flex flex-col gap-4 scroll-mt-20">
      <h2 id={`${id}-h`} className="border-b pb-2 text-xl font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {label ? <p className="text-xs font-medium text-muted-foreground">{label}</p> : null}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const brandScale = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const surfaces = [
  ["background", "bg-background"],
  ["surface-1 (sidebar)", "bg-surface-1"],
  ["surface-2 (card)", "bg-surface-2"],
  ["surface-3 (elevado)", "bg-surface-3"],
  ["muted", "bg-muted"],
  ["accent", "bg-accent"],
] as const;
const semantic = [
  ["primary", "bg-primary"],
  ["success", "bg-success"],
  ["warning", "bg-warning"],
  ["destructive", "bg-destructive"],
  ["info", "bg-info"],
  ["speaking", "bg-speaking"],
  ["online", "bg-online"],
  ["idle", "bg-idle"],
  ["dnd", "bg-dnd"],
  ["invisible", "bg-invisible"],
] as const;
const brandClass: Record<number, string> = {
  50: "bg-brand-50",
  100: "bg-brand-100",
  200: "bg-brand-200",
  300: "bg-brand-300",
  400: "bg-brand-400",
  500: "bg-brand-500",
  600: "bg-brand-600",
  700: "bg-brand-700",
  800: "bg-brand-800",
  900: "bg-brand-900",
  950: "bg-brand-950",
};

export function DesignSystemPage() {
  const { resolved } = useTheme();
  const [volume, setVolume] = useState([70]);
  const [on, setOn] = useState(true);
  const [loading, setLoading] = useState(false);

  return (
    <TooltipProvider>
      <div className="min-h-svh bg-brand-glow">
        <header className="sticky top-0 z-[var(--z-sticky)] flex items-center justify-between gap-4 border-b bg-background/85 px-6 py-3 backdrop-blur">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Design system do Spook</h1>
            <p className="text-xs text-muted-foreground">Tema atual: {resolved}</p>
          </div>
          <ThemeToggle />
        </header>

        <main className="mx-auto flex max-w-5xl flex-col gap-12 px-6 py-10">
          <Section id="cores" title="Cores">
            <Row label="Marca (brand-50 a 950); o 500 é o #7C5CC4 do logo">
              {brandScale.map((n) => (
                <div key={n} className="flex flex-col items-center gap-1">
                  <div className={`size-12 rounded-lg border ${brandClass[n]}`} />
                  <span className="text-2xs text-muted-foreground">{n}</span>
                </div>
              ))}
            </Row>
            <Row label="Superfícies em camadas">
              {surfaces.map(([name, cls]) => (
                <div key={name} className="flex flex-col items-center gap-1">
                  <div className={`h-12 w-24 rounded-lg border ${cls}`} />
                  <span className="text-2xs text-muted-foreground">{name}</span>
                </div>
              ))}
            </Row>
            <Row label="Semânticas e presença">
              {semantic.map(([name, cls]) => (
                <div key={name} className="flex flex-col items-center gap-1">
                  <div className={`size-12 rounded-full border ${cls}`} />
                  <span className="text-2xs text-muted-foreground">{name}</span>
                </div>
              ))}
            </Row>
          </Section>

          <Section id="tipografia" title="Tipografia">
            <div className="flex flex-col gap-2">
              <p className="text-4xl font-semibold tracking-tighter">
                Display 4xl · Seus servidores
              </p>
              <p className="text-3xl font-semibold tracking-tight">Título 3xl · Sua galera</p>
              <p className="text-2xl font-semibold tracking-tight">Título 2xl · Num só lugar</p>
              <p className="text-xl font-semibold tracking-tight">Seção xl · Chat, voz e vídeo</p>
              <p className="text-lg font-medium">Subtítulo lg · Compartilhar tela</p>
              <p className="text-base">
                Corpo base 16 · O Spook é um clone do Discord feito para estudo.
              </p>
              <p className="text-sm">Corpo sm 14 (padrão da interface) · Mensagens e listas.</p>
              <p className="text-xs text-muted-foreground">Legenda xs 12 · Hoje às 14:05</p>
              <p className="text-2xs text-muted-foreground">Mínimo 2xs 11 · contadores e selos</p>
              <p className="tabular text-sm">Números tabulares: 0123456789 · 1.234,56 · 12:45:08</p>
            </div>
          </Section>

          <Section id="raios-sombras" title="Raios, sombras e brilho">
            <Row label="Raios: xs, sm, md, lg, xl, 2xl, full">
              {[
                "rounded-xs",
                "rounded-sm",
                "rounded-md",
                "rounded-lg",
                "rounded-xl",
                "rounded-2xl",
                "rounded-full",
              ].map((c) => (
                <div key={c} className={`size-14 border bg-card ${c}`} />
              ))}
            </Row>
            <Row label="Sombras: xs, sm, md, lg, xl e glow (realce neon do mascote)">
              {["shadow-xs", "shadow-sm", "shadow-md", "shadow-lg", "shadow-xl", "shadow-glow"].map(
                (c) => (
                  <div
                    key={c}
                    className={`grid size-20 place-items-center rounded-xl border bg-card text-2xs ${c}`}
                  >
                    {c.replace("shadow-", "")}
                  </div>
                ),
              )}
            </Row>
          </Section>

          <Section id="botoes" title="Botões">
            {(
              ["default", "secondary", "soft", "outline", "ghost", "destructive", "link"] as const
            ).map((v) => (
              <Row key={v} label={v}>
                <Button variant={v} size="sm">
                  Pequeno
                </Button>
                <Button variant={v}>Padrão</Button>
                <Button variant={v} size="lg">
                  Grande
                </Button>
                <Button variant={v} size="xl">
                  Extra grande
                </Button>
                <Button variant={v}>
                  <Plus /> Com ícone
                </Button>
                <Button variant={v} size="icon" aria-label="Configurações">
                  <Settings />
                </Button>
                <Button variant={v} disabled>
                  Desativado
                </Button>
              </Row>
            ))}
            <Row label="Carregando (clique para simular)">
              <Button
                loading={loading}
                onClick={() => {
                  setLoading(true);
                  setTimeout(() => setLoading(false), 1800);
                }}
              >
                Salvar alterações
              </Button>
              <Button variant="outline" loading>
                Enviando
              </Button>
              <Spinner className="size-6 text-primary" />
            </Row>
          </Section>

          <Section id="campos" title="Campos e controles">
            <div className="grid gap-6 sm:grid-cols-2">
              <Field id="ds-name" label="Nome do servidor" hint="Aparece para todos os membros.">
                <Input id="ds-name" placeholder="Laboratório Spook" />
              </Field>
              <Field id="ds-err" label="E-mail" error="Informe um e-mail válido.">
                <Input id="ds-err" aria-invalid defaultValue="ana@" />
              </Field>
              <Field id="ds-dis" label="Desativado">
                <Input id="ds-dis" disabled defaultValue="Não editável" />
              </Field>
              <Field id="ds-sel" label="Expira em">
                <Select defaultValue="7d">
                  <SelectTrigger id="ds-sel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1h">1 hora</SelectItem>
                    <SelectItem value="7d">7 dias</SelectItem>
                    <SelectItem value="never">Nunca</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Field id="ds-ta" label="Mensagem" hint="Até 2000 caracteres.">
                  <Textarea id="ds-ta" placeholder="Escreva algo..." />
                </Field>
              </div>
            </div>
            <Row label="Switch (padrão, pequeno, desativado), slider e rótulo clicável">
              <Switch checked={on} onCheckedChange={setOn} aria-label="Notificações" />
              <Switch size="sm" defaultChecked aria-label="Pequeno" />
              <Switch disabled aria-label="Desativado" />
              <div className="flex w-64 flex-col gap-1">
                <Label>Volume: {volume[0]}%</Label>
                <Slider value={volume} onValueChange={setVolume} max={100} aria-label="Volume" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-primary" /> Lembrar de mim
              </label>
            </Row>
          </Section>

          <Section id="avatar" title="Avatar e presença">
            <Row label="Tamanhos (xs a 2xl)">
              {(Object.keys(avatarSizes) as (keyof typeof avatarSizes)[]).map((s) => (
                <Avatar key={s} name="Ana Lima" size={s} />
              ))}
            </Row>
            <Row label="Iniciais com cor derivada do id/username">
              {[
                "Ana Lima",
                "Bruno Reis",
                "Carla Nunes",
                "Davi",
                "Elis Moura",
                "fabio_dev",
                "Gabi",
                "Hugo Alves",
              ].map((n) => (
                <Avatar key={n} name={n} size="md" fallback="initials" seed={n} />
              ))}
            </Row>
            <Row label="Status (online, ausente, não perturbar, invisível, offline)">
              {(["online", "idle", "dnd", "invisible", "offline"] as const).map((s) => (
                <Avatar
                  key={s}
                  name="Ana Lima"
                  size="lg"
                  fallback="initials"
                  status={s}
                  statusRingClassName="ring-background"
                />
              ))}
            </Row>
            <Row label="Falando (anel verde)">
              <Avatar name="Bruno Reis" size="xl" fallback="initials" speaking />
              <Avatar name="Carla Nunes" size="xl" fallback="initials" />
            </Row>
          </Section>

          <Section id="feedback" title="Badges, contadores e avisos">
            <Row>
              <Badge variant="default">Novo</Badge>
              <Badge variant="brand">Dono</Badge>
              <Badge variant="secondary">Moderação</Badge>
              <Badge variant="outline">Beta</Badge>
              <Badge variant="success">Conectado</Badge>
              <Badge variant="warning">Atenção</Badge>
              <Badge variant="destructive">Erro</Badge>
              <Badge variant="info">Dica</Badge>
            </Row>
            <Row label="Contadores">
              <CountBadge count={1} />
              <CountBadge count={12} />
              <CountBadge count={99} />
              <CountBadge count={240} />
              <CountBadge count={7} tone="brand" />
            </Row>
            <Row label="Toasts">
              <Button variant="outline" onClick={() => toast("Link do convite copiado")}>
                Neutro
              </Button>
              <Button variant="outline" onClick={() => toast.success("Cargo salvo")}>
                Sucesso
              </Button>
              <Button variant="outline" onClick={() => toast.error("Não foi possível enviar")}>
                Erro
              </Button>
              <Button variant="outline" onClick={() => toast.warning("Microfone sem sinal")}>
                Aviso
              </Button>
              <Button variant="outline" onClick={() => toast.info("Nova versão disponível")}>
                Info
              </Button>
            </Row>
          </Section>

          <Section id="overlays" title="Diálogo, menus e dicas">
            <Row>
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Abrir diálogo</Button>
                </DialogTrigger>
                <DialogContent size="sm">
                  <DialogHeader>
                    <DialogTitle>Criar servidor</DialogTitle>
                    <DialogDescription>
                      Dê um nome para começar. Você pode mudar depois.
                    </DialogDescription>
                  </DialogHeader>
                  <Field id="ds-dlg" label="Nome">
                    <Input id="ds-dlg" placeholder="Meu servidor" />
                  </Field>
                  <DialogFooter>
                    <Button variant="ghost">Cancelar</Button>
                    <Button>Criar</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">
                    <Trash2 /> Excluir
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogTitle>Excluir o canal?</AlertDialogTitle>
                  <AlertDialogDescription>
                    As mensagens do canal serão apagadas para sempre.
                  </AlertDialogDescription>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction>Excluir</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">Menu</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-60">
                  <DropdownMenuLabel>Servidor</DropdownMenuLabel>
                  <DropdownMenuItem>
                    <Users /> Convidar pessoas <DropdownMenuShortcut>Ctrl I</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Settings /> Configurações
                  </DropdownMenuItem>
                  <DropdownMenuCheckboxItem checked>Mostrar membros</DropdownMenuCheckboxItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Bell /> Notificações
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem>Todas as mensagens</DropdownMenuItem>
                      <DropdownMenuItem>Só menções</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive>
                    <Trash2 /> Sair do servidor
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled>Indisponível</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <ContextMenu>
                <ContextMenuTrigger className="grid h-20 w-56 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
                  Clique com o botão direito
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem>
                    <Copy /> Copiar texto <ContextMenuShortcut>Ctrl C</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem>
                    <Download /> Baixar
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem destructive>
                    <Trash2 /> Excluir
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Silenciar">
                    <Mic />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Silenciar microfone <Kbd className="ml-1.5">M</Kbd>
                </TooltipContent>
              </Tooltip>
            </Row>
          </Section>

          <Section id="navegacao" title="Abas, divisores e rolagem">
            <Tabs defaultValue="a">
              <TabsList>
                <TabsTrigger value="a">Geral</TabsTrigger>
                <TabsTrigger value="b">Cargos</TabsTrigger>
                <TabsTrigger value="c">Convites</TabsTrigger>
              </TabsList>
              <TabsContent value="a" className="text-sm text-muted-foreground">
                Variante pill (padrão).
              </TabsContent>
            </Tabs>
            <Tabs defaultValue="a">
              <TabsList variant="underline">
                <TabsTrigger variant="underline" value="a">
                  Perfil
                </TabsTrigger>
                <TabsTrigger variant="underline" value="b">
                  Notificações
                </TabsTrigger>
                <TabsTrigger variant="underline" value="c">
                  Aplicativo
                </TabsTrigger>
              </TabsList>
              <TabsContent value="a" className="text-sm text-muted-foreground">
                Variante underline.
              </TabsContent>
            </Tabs>
            <Separator />
            <ScrollArea className="h-32 w-64 rounded-lg border">
              <div className="flex flex-col gap-2 p-3 text-sm">
                {Array.from({ length: 14 }, (_, i) => i + 1).map((n) => (
                  <span key={n}>Item rolável {n}</span>
                ))}
              </div>
            </ScrollArea>
          </Section>

          <Section id="carregando" title="Skeleton">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3 w-full max-w-sm" />
              </div>
            </div>
          </Section>

          <Section id="vazios" title="Estados vazios e ilustrações">
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                {
                  i: <EmptyChatIllustration />,
                  t: "Nada por aqui ainda",
                  d: "Seja a primeira pessoa a falar neste canal.",
                  a: <Button size="sm">Enviar mensagem</Button>,
                },
                {
                  i: <VoiceInviteIllustration />,
                  t: "Ninguém na sala",
                  d: "Entre para conversar por voz com a galera.",
                  a: <Button size="sm">Entrar na voz</Button>,
                },
                {
                  i: <NotFoundIllustration />,
                  t: "Página não encontrada",
                  d: "O link pode estar errado ou o conteúdo foi removido.",
                  a: (
                    <Button size="sm" variant="outline">
                      Voltar ao início
                    </Button>
                  ),
                },
              ].map((e) => (
                <Card key={e.t}>
                  <CardHeader className="sr-only">
                    <CardTitle>{e.t}</CardTitle>
                    <CardDescription>{e.d}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <EmptyState
                      className="p-2"
                      illustration={e.i}
                      title={e.t}
                      description={e.d}
                      action={e.a}
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
          </Section>

          <Section id="movimento" title="Movimento e foco">
            <p className="text-sm text-muted-foreground">
              Curvas: <code>ease-standard</code>, <code>ease-out</code>, <code>ease-in</code>,{" "}
              <code>ease-spring</code>. Durações: instant 80, fast 120, base 180, slow 260, slower
              400 ms. Só transform e opacity; com movimento reduzido tudo vira instantâneo. Use Tab
              para ver o anel de foco em cada controle desta página.
            </p>
            <Row>
              <Button variant="outline">
                <Search /> Foco por teclado
              </Button>
              <a
                href="#cores"
                className="text-sm font-medium text-brand-text underline-offset-4 hover:underline"
              >
                Link de exemplo
              </a>
            </Row>
          </Section>
        </main>
      </div>
    </TooltipProvider>
  );
}
