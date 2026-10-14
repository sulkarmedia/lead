"use client";
import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

export function LoginForm({ supabaseUrl, anonKey }: { supabaseUrl: string; anonKey: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const sb = createBrowserClient(supabaseUrl, anonKey);
  const redirectTo = `${window.location.origin}/auth/callback`;
  return (
    <div className="card space-y-3 p-4">
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setState("sending");
          const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } });
          if (error) {
            setError(error.message);
            setState("error");
          } else setState("sent");
        }}
      >
        <input className="w-full rounded-lg border border-app bg-transparent px-3 py-2 text-sm" type="email" required placeholder="you@business.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="w-full rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg" disabled={state === "sending"}>
          {state === "sent" ? "Check your email" : "Email me a sign-in link"}
        </button>
        {state === "error" && <p className="text-sm text-red-600">{error}</p>}
      </form>
      <button
        className="w-full rounded-lg border border-app px-3 py-2 text-sm"
        onClick={() => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo } })}
      >
        Continue with Google
      </button>
    </div>
  );
}
