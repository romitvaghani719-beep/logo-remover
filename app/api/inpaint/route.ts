import { NextRequest, NextResponse } from "next/server";
import { processInpaint } from "@/lib/inpaint";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const imageFile = formData.get("image");
    const maskFile = formData.get("mask");
    const featherPx = Number(formData.get("featherPx") ?? 12);

    if (!(imageFile instanceof Blob)) {
      return NextResponse.json({ error: "Image file is required" }, { status: 400 });
    }

    if (!(maskFile instanceof Blob)) {
      return NextResponse.json(
        { error: "Mask is required — mark the logo on the image first" },
        { status: 400 }
      );
    }

    const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
    const maskBuffer = Buffer.from(await maskFile.arrayBuffer());

    const resultBuffer = await processInpaint(imageBuffer, maskBuffer, featherPx);

    return new NextResponse(new Uint8Array(resultBuffer), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
      },
    });
  } catch (error) {
    console.error("Inpaint error:", error);
    const message = error instanceof Error ? error.message : "Inpaint failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
