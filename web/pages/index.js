import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { AppHead } from "@/components/AppHead";
import { AuthCard } from "@/components/AuthCard";
import { apiFetch } from "@/lib/api";
import { useAppStore } from "@/store/useAppStore";

export default function HomePage() {
  const router = useRouter();
  const { token, hydrateAuth, setAuth } = useAppStore();
  const [mode, setMode] = useState("login");
  const [registerAllowed, setRegisterAllowed] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/auth/config")
      .then((data) => {
        if (!mounted) return;
        setRegisterAllowed(data.allowRegistration !== false);
        if (data.allowRegistration === false && mode === "register") {
          setMode("login");
        }
      })
      .catch(() => {
        if (!mounted) return;
        setRegisterAllowed(true);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (token) {
      router.replace("/dashboard");
    }
  }, [router, token]);

  const handleSubmit = async (values) => {
    setSubmitting(true);
    setError("");

    if (mode === "register" && !registerAllowed) {
      setError("Registration is currently disabled.");
      setSubmitting(false);
      return;
    }

    try {
      const result = await apiFetch(`/api/auth/${mode}`, {
        method: "POST",
        body: values,
      });

      setAuth(result);
      router.replace("/dashboard");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <AppHead
        title={mode === "login" ? "Login" : "Register"}
        description="Sign in or register for your Wanie workspace to manage sessions and chats from one dashboard."
      />

      <main className="min-h-screen bg-[linear-gradient(180deg,#0b141a_0%,#111b21_100%)] px-6 py-8">
        <AuthCard
          mode={mode}
          error={error}
          busy={submitting}
          registerAllowed={registerAllowed}
          onModeChange={(nextMode) => {
            if (nextMode === "register" && !registerAllowed) return;
            setMode(nextMode);
          }}
          onSubmit={handleSubmit}
        />
      </main>
    </>
  );
}
