import { PROVIDERS } from "./index";
import type { ImagePart, ProviderId } from "./types";
import { getProvidersWithKeys } from "../settings";

/**
 * Returns true if the given provider + model can accept image inputs.
 * Falls back to provider-level supports_vision when the model doesn't
 * specify. Defaults to false.
 */
export function providerSupportsVision(providerId: ProviderId, modelId: string): boolean {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return false;
  const model = provider.models.find((m) => m.id === modelId);
  if (model?.supports_vision !== undefined) return model.supports_vision;
  return provider.supports_vision === true;
}

/**
 * Find a vision-capable provider that the user has a saved key for.
 * Used when the active provider can't read images — we can either prompt the
 * user to switch or automatically pick the first matching fallback.
 *
 * Preference order: anthropic > openai > google > openrouter. Reflects the
 * quality ceiling for vision tasks per provider docs as of 2026.
 */
export function pickVisionProvider(excluding?: ProviderId): ProviderId | null {
  const PREFERENCE: ProviderId[] = ["anthropic", "openai", "google", "openrouter"];
  const withKeys = new Set(getProvidersWithKeys());
  for (const id of PREFERENCE) {
    if (id === excluding) continue;
    if (!withKeys.has(id)) continue;
    if (providerSupportsVision(id, PROVIDERS.find((p) => p.id === id)?.default_model ?? "")) return id;
  }
  // Fallback: any provider with a key that flags vision.
  for (const id of withKeys) {
    if (id === excluding) continue;
    const p = PROVIDERS.find((x) => x.id === id);
    if (p?.supports_vision) return p.id;
  }
  return null;
}

/** Limits chosen so the BASE64-ENCODED payload stays under provider caps.
 *
 *  Base64 inflates by ~4/3, so the old 4.5 MB raw ceiling produced a ~6 MB
 *  encoded image — over Anthropic's ~5 MB per-image limit, meaning uploads at
 *  the documented maximum were rejected by the API after the user had already
 *  waited through the encode. 3.5 MB raw ≈ 4.7 MB encoded, which fits Claude
 *  (~5 MB), OpenAI (~20 MB total), and Gemini (~7 MB). */
export const VISION_LIMITS = {
  max_bytes_per_image: 3_500_000, // 3.5 MB raw ≈ 4.7 MB base64
  allowed_mime_types: ["image/png", "image/jpeg", "image/webp", "image/gif"] as const,
};

/** Human-readable ceiling, kept in sync with max_bytes_per_image for UI copy. */
export const MAX_IMAGE_MB = (VISION_LIMITS.max_bytes_per_image / 1_000_000).toFixed(1);

/**
 * Base64-encode bytes without melting the main thread.
 *
 * The previous implementation was
 *   `bytes.reduce((acc, b) => acc + String.fromCharCode(b), "")`
 * which allocates a fresh string per byte — millions of intermediate
 * allocations for a multi-MB image, several seconds of frozen UI, and a real
 * OOM risk on low-end devices. Chunked `fromCharCode.apply` does the same work
 * in a few thousand calls. The chunk size stays well under the argument-count
 * limit that makes `apply` throw RangeError.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32 KB
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

/**
 * Read a browser File / Blob and convert it into our neutral ImagePart format.
 * Validates MIME type + size. Throws Error with a user-friendly message.
 */
export async function fileToImagePart(file: File | Blob): Promise<ImagePart> {
  const mime = (file as File).type || "image/png";
  if (!VISION_LIMITS.allowed_mime_types.includes(mime as any)) {
    throw new Error(`Unsupported image type "${mime}". Use PNG, JPEG, WebP, or GIF.`);
  }
  if (file.size > VISION_LIMITS.max_bytes_per_image) {
    const mb = (file.size / 1_000_000).toFixed(1);
    throw new Error(
      `Image is ${mb} MB — keep it under ${MAX_IMAGE_MB} MB (providers cap the base64-encoded size, which is ~33% larger than the file).`
    );
  }
  const buf = await file.arrayBuffer();
  const data = bytesToBase64(new Uint8Array(buf));
  return { type: "image", media_type: mime as ImagePart["media_type"], data };
}
