import { useGetMe } from "@spook/shared";
import { Link } from "@tanstack/react-router";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function HomePage() {
  const { data: me } = useGetMe();
  if (!me) return null;
  const name = me.display_name || me.username;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4">
        <Avatar url={me.avatar_url} name={name} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{name}</h1>
          <p className="text-sm text-muted-foreground">@{me.username}</p>
          <p className="truncate text-sm text-muted-foreground">{me.email}</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/settings/profile">Editar perfil</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
