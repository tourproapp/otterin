// Pairing offer capture (PLAN §8, spec 021).
//
// The Connector renders the pairing offer as a QR. We capture a full-screen
// desktopCapturer source at real pixel size — window-source thumbnails are
// nondeterministically empty on Electron >=29.1 and default to 150x150 —
// and decode with jsQR.
//
// Spec-021 transit: the decoded payload is a one-shot value held ONLY in
// this module's memory — never logged, never sent to the renderer, never
// persisted. The renderer receives a redacted preview (non-secret fields)
// and consumes the payload via 'pair:submit'.

import { execFile } from 'node:child_process';
import jsQR from 'jsqr';
import { z } from 'zod';

import {
  createDeviceIdentity,
  deleteDeviceIdentity,
  fingerprintPublicKeySpki,
} from '../../../client-core/src/deviceSigning';

export type PairingCaptureErrorCode =
  | 'screen_permission_denied'
  | 'qr_not_found'
  | 'qr_invalid'
  | 'offer_expired'
  | 'connector_not_installed'
  | 'capture_unavailable';

export class PairingCaptureError extends Error {
  constructor(
    message: string,
    readonly code: PairingCaptureErrorCode,
  ) {
    super(message);
    this.name = 'PairingCaptureError';
  }
}

const CONNECTOR_APP_NAME = 'Otterin Connector';
const CONNECTOR_REOPEN_DELAY_MS = 1_500;
const MAX_CAPTURE_ATTEMPTS = 3;
const MAX_QR_PAYLOAD_BYTES = 4_096;
const MAX_IMAGE_PIXELS = 33_177_600; // 8K UHD — generous bound for canvas imports

// Redacted preview of the offer for the pairing screen. The authoritative
// schema lives in client-core computerPairing.ts — this only projects the
// non-secret display fields and deliberately excludes pairingSecret.
const offerPreviewSchema = z
  .object({
    protocolVersion: z.literal(2),
    bridgeId: z.string().min(16).max(128),
    bridgeKeyFingerprint: z.string().length(43),
    transportSecurity: z.enum(['tailscale_wireguard', 'pinned_tls']),
    pairingId: z.string().min(16).max(128),
    expiresAt: z.number().int().positive(),
    computerName: z.string().min(1).max(80).optional(),
  })
  .passthrough();
export type PairingOfferPreview = z.infer<typeof offerPreviewSchema> & {
  /** Our submitting device's SAS fingerprint — shown for comparison against
   * the fingerprint the Connector approval dialog displays. */
  deviceKeyFingerprint?: string;
};

interface StashedDeviceIdentity {
  keyId: string;
  publicKeySpki: string;
}

function electronApi(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as typeof import('electron');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * desktopCapturer bitmaps are BGRA premultiplied on macOS. jsQR wants RGBA;
 * QR codes are bimodal black/white so even a wrong channel order would
 * likely decode, but do the swap properly.
 */
export function bgraToRgba(bitmap: Buffer): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(bitmap.length);
  for (let i = 0; i < bitmap.length; i += 4) {
    rgba[i] = bitmap[i + 2] ?? 0;
    rgba[i + 1] = bitmap[i + 1] ?? 0;
    rgba[i + 2] = bitmap[i] ?? 0;
    rgba[i + 3] = bitmap[i + 3] ?? 0;
  }
  return rgba;
}

export function decodeQrFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
    return null;
  }
  if (rgba.length !== width * height * 4) {
    return null;
  }
  const code = jsQR(rgba, width, height);
  if (code === null || code.data.length === 0 || code.data.length > MAX_QR_PAYLOAD_BYTES) {
    return null;
  }
  return code.data;
}

function assertScreenAccess(): void {
  const { systemPreferences } = electronApi();
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'denied' || status === 'restricted') {
    throw new PairingCaptureError(
      'Screen Recording permission is off — enable it for Otterin in System Settings > Privacy & Security > Screen Recording',
      'screen_permission_denied',
    );
  }
}

/**
 * 'not-determined' means there is no TCC record at all — the app will not
 * even appear in System Settings > Screen Recording for the user to toggle.
 * Electron 33 has no askForMediaAccess('screen') and getSources preflights
 * the permission without registering, so the entry never materialises.
 *
 * Spawning this JXA one-liner calls CGRequestScreenCaptureAccess from a
 * child process — TCC responsibility is inherited from the spawning app, so
 * the system prompt and the Settings list entry say "Otterin". The return
 * value doesn't matter: the post-capture check reports the true status.
 */
const JXA_REQUEST_SCREEN_ACCESS =
  'ObjC.import("CoreGraphics");' +
  'ObjC.bindFunction("CGRequestScreenCaptureAccess", ["BOOL", []]);' +
  '$.CGRequestScreenCaptureAccess()';

function requestScreenAccessIfNeeded(): Promise<void> {
  const { systemPreferences } = electronApi();
  if (systemPreferences.getMediaAccessStatus('screen') !== 'not-determined') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', JXA_REQUEST_SCREEN_ACCESS],
      { timeout: 15_000 },
      () => resolve(),
    );
  });
}

/**
 * One capture pass across all displays. Returns the first decoded payload
 * that previews as a pairing offer. A QR that decodes but is not an offer
 * does not stop the scan of remaining displays — an unrelated QR code on
 * screen is not our pairing code.
 */
async function captureOnce(): Promise<string> {
  const { desktopCapturer, screen } = electronApi();
  await requestScreenAccessIfNeeded();
  assertScreenAccess();
  let sawNonOfferQr = false;
  for (const display of screen.getAllDisplays()) {
    const pixelWidth = Math.max(1, Math.round(display.size.width * display.scaleFactor));
    const pixelHeight = Math.max(1, Math.round(display.size.height * display.scaleFactor));
    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: pixelWidth, height: pixelHeight },
        fetchWindowIcons: false,
      });
    } catch {
      continue;
    }
    const source = sources.find((candidate) => candidate.display_id === String(display.id));
    const thumbnail = source?.thumbnail;
    if (!source || !thumbnail || thumbnail.isEmpty()) {
      continue;
    }
    const bitmap = thumbnail.toBitmap();
    const size = thumbnail.getSize();
    if (bitmap.length !== size.width * size.height * 4) {
      continue;
    }
    const payload = decodeQrFromRgba(bgraToRgba(bitmap), size.width, size.height);
    if (payload === null) {
      continue;
    }
    if (offerPreviewSchema.safeParse(safeJsonParse(payload)).success) {
      return payload;
    }
    sawNonOfferQr = true;
  }
  if (sawNonOfferQr) {
    throw new PairingCaptureError(
      'The QR code on screen was not an Otterin pairing code',
      'qr_invalid',
    );
  }
  // Without a Screen Recording grant macOS hands back wallpaper-only
  // thumbnails — windows (and any QR inside them) never reach the decoder.
  // 'not-determined' lands here too: the capture attempt above registers the
  // app in the TCC list, so report the grant path rather than "no QR".
  const { systemPreferences } = electronApi();
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    throw new PairingCaptureError(
      'Screen Recording permission is required to see the QR — enable it for Otterin in System Settings > Privacy & Security > Screen Recording, restart the app, then try again',
      'screen_permission_denied',
    );
  }
  throw new PairingCaptureError(
    'No pairing QR was visible on any screen — open Otterin Connector so its pairing view is showing',
    'qr_not_found',
  );
}

function safeJsonParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function reopenConnector(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-a', CONNECTOR_APP_NAME], (error) => {
      if (error) {
        reject(
          new PairingCaptureError(
            'Otterin Connector is not installed on this Mac',
            'connector_not_installed',
          ),
        );
        return;
      }
      resolve();
    });
  });
}

export interface CaptureResult {
  preview: PairingOfferPreview;
  attempts: number;
}

/**
 * Capture -> decode -> stash. On qr_not_found, fires
 * `open -a "Otterin Connector"` once (its reopen handler shows the pairing
 * window), waits, then retries up to MAX_CAPTURE_ATTEMPTS captures total.
 * The payload never leaves this function's stash — see pendingOffer.
 */
export async function capturePairingOffer(): Promise<CaptureResult> {
  let lastError: PairingCaptureError | null = null;
  let reopenFired = false;
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    try {
      const payload = await captureOnce();
      const preview = previewOffer(payload);
      await stashPendingOffer(payload, preview);
      return { preview, attempts: attempt };
    } catch (error) {
      if (
        error instanceof PairingCaptureError &&
        error.code !== 'qr_not_found' &&
        error.code !== 'qr_invalid'
      ) {
        throw error;
      }
      lastError =
        error instanceof PairingCaptureError
          ? error
          : new PairingCaptureError('Screen capture failed', 'capture_unavailable');
      if (!reopenFired) {
        reopenFired = true;
        await reopenConnector(); // throws connector_not_installed if absent
      }
      await wait(CONNECTOR_REOPEN_DELAY_MS);
    }
  }
  throw lastError ?? new PairingCaptureError('Screen capture failed', 'capture_unavailable');
}

/** Decode a renderer-supplied RGBA frame (canvas ImageData from a dropped
 *  screenshot — the zero-permission fallback in PLAN §8). */
export async function importPairingOfferPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<CaptureResult> {
  const payload = decodeQrFromRgba(rgba, width, height);
  if (payload === null) {
    throw new PairingCaptureError('No pairing QR was found in that image', 'qr_not_found');
  }
  const preview = previewOffer(payload);
  // Screenshots go stale — a QR captured minutes ago carries an already-dead
  // offer. Fail here so the scan step can say so, rather than showing the
  // approve screen and erroring on submit.
  if (preview.expiresAt <= Date.now()) {
    throw new PairingCaptureError(
      'That QR has already expired — take a fresh screenshot of the Connector pairing window',
      'offer_expired',
    );
  }
  await stashPendingOffer(payload, preview);
  return { preview, attempts: 1 };
}

function previewOffer(payload: string): PairingOfferPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new PairingCaptureError('The QR code was not an Otterin pairing code', 'qr_invalid');
  }
  const result = offerPreviewSchema.safeParse(parsed);
  if (!result.success) {
    throw new PairingCaptureError('The QR code was not an Otterin pairing code', 'qr_invalid');
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// One-shot pending-offer stash. The decoded payload lives here until
// 'pair:submit' consumes it or 'pair:capture'/'pair:import' overwrites it.
// ---------------------------------------------------------------------------

interface PendingOffer {
  payload: string;
  preview: PairingOfferPreview;
  stashedAt: number;
  /** Device identity created at capture time so the approve screen can show
   * the submitting key's fingerprint before it is sent. Reused by
   * pair:submit via options.deviceIdentity — if pairing created a fresh key
   * instead, the displayed fingerprint would not match the approved one. */
  deviceIdentity: StashedDeviceIdentity;
}

let pendingOffer: PendingOffer | null = null;

async function stashPendingOffer(payload: string, preview: PairingOfferPreview): Promise<void> {
  const previous = pendingOffer;
  pendingOffer = null;
  if (previous) await deleteDeviceIdentity(previous.deviceIdentity.keyId).catch(() => undefined);
  const deviceIdentity = await createDeviceIdentity();
  preview.deviceKeyFingerprint = await fingerprintPublicKeySpki(deviceIdentity.publicKeySpki);
  pendingOffer = { payload, preview, stashedAt: Date.now(), deviceIdentity };
}

export function hasPendingOffer(): boolean {
  return pendingOffer !== null;
}

export function getPendingOfferPreview(): PairingOfferPreview | null {
  return pendingOffer?.preview ?? null;
}

export function clearPendingOffer(): void {
  const offer = pendingOffer;
  pendingOffer = null;
  if (offer) void deleteDeviceIdentity(offer.deviceIdentity.keyId).catch(() => undefined);
}

/**
 * Returns the stashed payload and zeroes the slot. Refuses offers whose
 * expiry has already passed — client-core re-validates authoritatively.
 */
export function consumePendingOffer(): {
  payload: string;
  deviceIdentity: StashedDeviceIdentity;
} {
  const offer = pendingOffer;
  pendingOffer = null;
  if (!offer) {
    throw new PairingCaptureError('No captured pairing code is waiting', 'qr_not_found');
  }
  if (offer.preview.expiresAt <= Date.now()) {
    void deleteDeviceIdentity(offer.deviceIdentity.keyId).catch(() => undefined);
    throw new PairingCaptureError(
      'The pairing code has expired — capture a fresh one',
      'offer_expired',
    );
  }
  return { payload: offer.payload, deviceIdentity: offer.deviceIdentity };
}
