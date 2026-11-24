"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Redirect target of Meta's "Facebook Login for Business" (Instagram API).
 * Meta returns the tokens in the URL fragment (#access_token=…&long_lived_token=…&state=…), which never
 * reaches any server. We read it here, wipe it from the address bar/history at once, and send only the
 * long-lived token to the backend, which verifies it belongs to our Meta app and stores it encrypted.
 */
export default function InstagramCallbackPage() {
  const router = useRouter();
  const [state, setState] = useState<{ kind: "working" | "ok" | "error"; message: string }>({ kind: "working", message: "Connecting Instagram…" });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", "/settings/instagram-callback"); // remove tokens from the URL immediately

    const error = frag.get("error_description") ?? query.get("error_description") ?? frag.get("error") ?? query.get("error");
    if (error) {
      setState({ kind: "error", message: `Instagram connection was cancelled or refused: ${error}` });
      return;
    }
    const token = frag.get("long_lived_token") ?? frag.get("access_token");
    const st = frag.get("state") ?? query.get("state");
    if (!token || !st) {
      setState({ kind: "error", message: "Meta did not return a token. Start again from Settings → Social accounts." });
      return;
    }
    api.post<{ username: string }>("/publishing/accounts/instagram/login", { longLivedToken: token, state: st })
      .then((r) => {
        setState({ kind: "ok", message: `Instagram connected: @${r.username}` });
        setTimeout(() => router.replace("/settings?tab=social&connected=instagram"), 1500);
      })
      .catch((e) => setState({ kind: "error", message: errMsg(e) }));
  }, [router]);

  return (
    <div className="grid min-h-[60vh] place-items-center">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          {state.kind === "working" && <Loader2 className="size-8 animate-spin text-primary" />}
          {state.kind === "ok" && <CheckCircle2 className="size-8 text-emerald-400" />}
          {state.kind === "error" && <XCircle className="size-8 text-red-400" />}
          <p className="text-sm">{state.message}</p>
          {state.kind === "error" && <Button variant="outline" onClick={() => router.replace("/settings?tab=social")}>Back to Settings</Button>}
        </CardContent>
      </Card>
    </div>
  );
}
