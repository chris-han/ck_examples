"use client";

import { useEffect, useState } from "react";
import { Loader2, Wifi, WifiOff } from "lucide-react";

const POLL_INTERVAL_MS = 10000;

interface HealthResponse {
  ok: boolean;
  status: number;
  message?: string;
}

type Status = "checking" | "healthy" | "error";

function mapStatusToLabel(status: Status): string {
  switch (status) {
    case "healthy":
      return "MCP Connected";
    case "checking":
      return "Checking MCP";
    default:
      return "MCP Offline";
  }
}

function mapStatusToTitle(status: Status, details?: string): string {
  const base =
    status === "healthy"
      ? "Model Context Protocol SSE connection is healthy"
      : status === "checking"
      ? "Checking Model Context Protocol SSE connection"
      : "Model Context Protocol SSE connection is unavailable";
  if (details) {
    return `${base}: ${details}`;
  }
  return base;
}

export default function SSEStatusIndicator(): JSX.Element {
  const [status, setStatus] = useState<Status>("checking");
  const [details, setDetails] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const runCheck = async () => {
      try {
        const response = await fetch("/api/mcp/health", { cache: "no-store" });
        const data = (await response.json()) as HealthResponse;
        if (cancelled) return;
        if (data.ok) {
          setStatus("healthy");
        } else {
          setStatus("error");
        }
        setDetails(data.message || "");
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setDetails(error instanceof Error ? error.message : "Unknown error");
      }
    };

    runCheck();
    const timer = setInterval(runCheck, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const title = mapStatusToTitle(status, details);
  const label = mapStatusToLabel(status);

  return (
    <div className="flex items-center gap-2" title={title}>
      {status === "healthy" && <Wifi className="h-4 w-4 text-green-400" />}
      {status === "checking" && <Loader2 className="h-4 w-4 animate-spin text-amber-300" />}
      {status === "error" && <WifiOff className="h-4 w-4 text-red-400" />}
      <span className="text-xs font-medium uppercase tracking-wide text-white">
        {label}
      </span>
    </div>
  );
}
