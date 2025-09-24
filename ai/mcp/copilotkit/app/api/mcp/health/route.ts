import { NextResponse } from "next/server";

interface HealthResult {
  ok: boolean;
  status: number;
  message?: string;
}

function buildHealthUrl(): URL {
  const endpoint = process.env.NEXT_PUBLIC_MCP_ENDPOINT || "http://localhost:7000/sse";
  const target = new URL(endpoint);
  const segments = target.pathname
    .split("/")
    .filter(Boolean);

  if (segments.length === 0) {
    target.pathname = "/health";
  } else {
    segments[segments.length - 1] = "health";
    target.pathname = `/${segments.join("/")}`;
  }

  target.search = "";
  target.hash = "";
  return target;
}

export async function GET(): Promise<NextResponse<HealthResult>> {
  const url = buildHealthUrl();

  try {
    const response = await fetch(url, { cache: "no-store" });
    const message = await response.text();

    return NextResponse.json({
      ok: response.ok,
      status: response.status,
      message: message.trim(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        status: 0,
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 200 },
    );
  }
}
