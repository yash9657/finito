import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Organization, Profile, ProfileRole } from "@/lib/types";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const ROLE_VARIANT: Record<ProfileRole, "accent" | "warning" | "muted"> = {
  admin: "accent",
  reviewer: "warning",
  analyst: "muted",
};

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // RLS scopes both reads to the caller's org.
  const [{ data: orgData }, { data: membersData }] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name, created_at")
      .limit(1)
      .maybeSingle<Organization>(),
    supabase
      .from("profiles")
      .select("id, email, org_id, role, created_at")
      .order("created_at", { ascending: true }),
  ]);

  const members = (membersData ?? []) as Profile[];

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">Organization and members.</p>
      </header>

      {/* Organization */}
      <section className="mb-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted">
              Organization
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold tracking-tight">
              {orgData?.name ?? "—"}
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Members */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-muted">
          Members ({members.length})
        </h2>
        <Card>
          {members.length === 0 ? (
            <CardContent className="p-8 text-center text-sm text-muted">
              No members found.
            </CardContent>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-mono text-xs">
                      {m.email}
                      {m.id === user?.id && (
                        <span className="ml-2 text-muted">(you)</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ROLE_VARIANT[m.role]}>{m.role}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>

      {/* Sign out */}
      <section>
        <form action={signOut}>
          <Button type="submit" variant="outline">
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </form>
      </section>
    </div>
  );
}
