import { NextResponse } from "next/server";
import { INPAINT_API_URL } from "@/lib/inpaint";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true, api: INPAINT_API_URL });
}
