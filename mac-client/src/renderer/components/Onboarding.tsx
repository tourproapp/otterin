/**
 * First-run onboarding: welcome → pair:capture (retry + "Open Otterin
 * Connector" when no QR is up) → pair:submit approval wait with the SAS
 * fingerprints side by side → grants checklist read from bridge:features →
 * done. Device name is the fixed "Otterin (Mac)".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

import { useApp } from '../store';
import type { ComputerGrants, PairCapture } from '../types';
import { Icon, type IconName } from './Icon';

const DEVICE_NAME = 'Otterin (Mac)';

type Step = 'welcome' | 'scan' | 'approve' | 'grants' | 'done';

type CaptureOk = Extract<PairCapture, { status: 'captured' }>;
type CaptureFailReason = Extract<PairCapture, { status: 'failed' }>['reason'];

const CAPTURE_FAILURE_COPY: Record<CaptureFailReason, string> = {
  no_qr: 'No pairing QR found on screen. Open Otterin Connector and show its pairing window, then try again.',
  capture_denied: 'Screen recording permission was denied. Grant it in System Settings, then try again.',
  invalid: 'The QR on screen was not a valid Otterin pairing offer. Show the pairing window and try again.',
  version_incompatible:
    'This Connector version is too old to pair. Update Otterin Connector, then try again.',
};

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ['welcome', 'scan', 'approve', 'grants', 'done'];
  const index = order.indexOf(step);
  return (
    <div className="flex items-center justify-center gap-1.5">
      {order.map((item, i) => (
        <span
          key={item}
          className={clsx(
            'h-1.5 rounded-full',
            i === index ? 'w-4 bg-brand' : i < index ? 'w-1.5 bg-brand/60' : 'w-1.5 bg-textLow/40',
          )}
        />
      ))}
    </div>
  );
}

function BigFingerprint({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className={clsx(
        'flex-1 rounded-card border px-4 py-3 text-center',
        highlight ? 'border-brand bg-tintPrimary' : 'border-borderSubtle bg-surface2',
      )}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-textLow">{label}</div>
      <div className="mt-1.5 break-all font-mono text-[15px] font-semibold leading-6 tracking-[0.08em] text-textHi">
        {value}
      </div>
    </div>
  );
}

export function Onboarding({ onDone }: { onDone(): void }) {
  const store = useApp();
  const [step, setStep] = useState<Step>('welcome');
  const [capture, setCapture] = useState<CaptureOk | null>(null);
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'failed'>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanReason, setScanReason] = useState<CaptureFailReason | null>(null);
  const [submitState, setSubmitState] = useState<'waiting' | 'denied' | 'expired' | 'error'>('waiting');
  const [grants, setGrants] = useState<ComputerGrants | null>(null);
  const [pairedName, setPairedName] = useState<string | null>(null);
  const [connectorOpenNote, setConnectorOpenNote] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const submitting = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runCapture = useCallback(async () => {
    setScanState('scanning');
    setScanError(null);
    setScanReason(null);
    try {
      const result = await store.bridge.pairCapture();
      if (result.status === 'captured') {
        setCapture(result);
        setSubmitState('waiting');
        setStep('approve');
      } else {
        setScanState('failed');
        setScanReason(result.reason);
        setScanError(CAPTURE_FAILURE_COPY[result.reason]);
      }
    } catch {
      setScanState('failed');
      setScanError(
        'Could not scan for the pairing QR. Make sure Otterin Connector is open, then try again.',
      );
    }
  }, [store]);

  const runSubmit = useCallback(
    async (captured: CaptureOk) => {
      if (submitting.current) return;
      submitting.current = true;
      try {
        const result = await store.bridge.pairSubmit(DEVICE_NAME);
        if (result.status === 'approved') {
          setPairedName(result.computerName ?? captured.computerName ?? 'your computer');
          void store.bridge
            .listComputers()
            .then((computers) => {
              const newest = [...computers].sort((a, b) => b.pairedAt - a.pairedAt)[0];
              if (newest) {
                return store
                  .ensureFeatures(newest.bridgeId)
                  .then((features) => setGrants(features.presentation?.grants ?? null))
                  .catch(() => setGrants(null));
              }
              return undefined;
            })
            .catch(() => undefined);
          void store.refreshComputers();
          setStep('grants');
        } else {
          setSubmitState(result.status);
        }
      } catch {
        setSubmitState('error');
      } finally {
        submitting.current = false;
      }
    },
    [store],
  );

  useEffect(() => {
    if (step === 'approve' && capture && submitState === 'waiting' && !submitting.current) {
      void runSubmit(capture);
    }
  }, [step, capture, submitState, runSubmit]);

  const openConnector = useCallback(() => {
    setConnectorOpenNote(true);
    void store.bridge.openConnector().catch(() => undefined);
  }, [store]);

  // Zero-permission fallback: a screenshot of the Connector's QR dropped,
  // pasted, or picked here decodes through the same one-shot offer path as
  // the live screen scan — nothing is saved or uploaded.
  const importScreenshot = useCallback(
    async (file: File) => {
      setScanState('scanning');
      setScanError(null);
      try {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D unavailable');
        context.drawImage(bitmap, 0, 0);
        const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
        bitmap.close();
        const result = await store.bridge.pairImport({
          width: image.width,
          height: image.height,
          rgba: image.data,
        });
        if (result.status === 'captured') {
          setCapture(result);
          setSubmitState('waiting');
          setStep('approve');
        } else {
          setScanState('failed');
          setScanError(
            'No pairing QR was found in that image. Take a fresh screenshot of the Connector pairing window and try again.',
          );
        }
      } catch {
        setScanState('failed');
        setScanError(
          'Could not read that image. Use a PNG screenshot of the Connector pairing window.',
        );
      }
    },
    [store],
  );

  // ⌘V works too — Finder screenshots and most copy sources arrive as a
  // clipboard file. Only while the scan step is up.
  useEffect(() => {
    if (step !== 'scan') return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const file = event.clipboardData?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        event.preventDefault();
        void importScreenshot(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [step, importScreenshot]);

  const grantRows: [string, boolean | undefined, string][] = [
    ['View sessions', grants?.viewSessions, 'See history and live activity'],
    ['Send prompts', grants?.sendPrompts, 'Send messages and answer questions'],
    ['Start sessions', grants?.startSessions, 'Create new sessions from this Mac'],
  ];

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col items-center justify-center bg-surface0 px-8"
      onDragEnter={(event) => {
        if (step === 'scan') {
          event.preventDefault();
          setDropActive(true);
        }
      }}
      onDragOver={(event) => {
        if (step === 'scan') event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={(event) => {
        if (step !== 'scan') return;
        event.preventDefault();
        setDropActive(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void importScreenshot(file);
      }}
    >
      <div className="titlebar-drag fixed inset-x-0 top-0 h-12" />
      {dropActive && step === 'scan' && (
        <div className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-sheet border-2 border-dashed border-brand bg-surface0/85">
          <div className="text-center">
            <Icon name="desktop" size={36} className="mx-auto text-brand" />
            <div className="mt-3 text-[14px] font-medium text-textHi">
              Drop the QR screenshot to pair
            </div>
          </div>
        </div>
      )}
      <div className="w-full max-w-md">
        {step === 'welcome' && (
          <div className="text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-sheet bg-brand">
              <Icon name="sparkle" size={30} className="text-textAlwaysWhite" />
            </div>
            <h1 className="mt-6 text-[22px] font-semibold text-textHiStrong">Otterin for Mac</h1>
            <p className="mt-3 text-[14px] leading-6 text-textMid">
              Pair this Mac with a computer running Otterin Connector to watch live Devin sessions,
              answer questions, and start new work — all over your local network.
            </p>
            <div className="mt-6 space-y-2.5 text-left">
              {([
                ['desktop', 'Sessions stay on the computer that owns them.'],
                ['lock', 'Pairing is one QR scan plus an approval in Connector.'],
                ['sparkle', 'You can monitor, answer, or create sessions by grant.'],
              ] as [IconName, string][]).map(([icon, copy]) => (
                <div key={copy} className="flex items-center text-[13px] text-textMid">
                  <Icon name={icon} size={15} className="mr-2.5 shrink-0 text-brand" />
                  {copy}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-8 w-full rounded-card bg-brand py-3 text-[14px] font-medium text-textAlwaysWhite hover:bg-brandHover"
              onClick={() => {
                setStep('scan');
                void runCapture();
              }}
            >
              Pair this Mac
            </button>
          </div>
        )}

        {step === 'scan' && (
          <div className="text-center">
            <Icon name="desktop" size={40} className="mx-auto text-textMid" />
            <h2 className="mt-4 text-[18px] font-semibold text-textHiStrong">
              Find the pairing QR
            </h2>
            <p className="mt-2 text-[13px] leading-5 text-textMid">
              Open Otterin Connector on the computer you want to pair with and show its pairing
              window. Otterin for Mac scans your screen for the QR — nothing is saved or uploaded.
            </p>
            {scanState === 'scanning' ? (
              <div className="mt-6 flex items-center justify-center text-[13px] text-textMid">
                <span className="mr-2 h-2 w-2 animate-otterin-pulse rounded-dot bg-brand" />
                Scanning for the pairing QR…
              </div>
            ) : (
              scanError && (
                <div className="mt-5 rounded-card border border-border bg-surface1 px-4 py-3 text-[12px] leading-5 text-textMid">
                  {scanError}
                  {scanReason === 'capture_denied' && (
                    <button
                      type="button"
                      className="mt-2.5 w-full rounded-card border border-border py-2 text-[12px] font-medium text-textHi hover:bg-tintSecondary"
                      onClick={() =>
                        void store.bridge.openScreenSettings().catch(() => undefined)
                      }
                    >
                      Open Screen Recording Settings
                    </button>
                  )}
                </div>
              )
            )}
            <div className="mt-6 space-y-2">
              <button
                type="button"
                className="w-full rounded-card border border-border py-2.5 text-[13px] font-medium text-textMid hover:bg-tintSecondary"
                onClick={openConnector}
              >
                Open Otterin Connector
              </button>
              {connectorOpenNote && (
                <div className="text-[11px] text-textLow">
                  If nothing opened, launch Otterin Connector from Applications.
                </div>
              )}
              <button
                type="button"
                className="w-full rounded-card bg-brand py-2.5 text-[13px] font-medium text-textAlwaysWhite hover:bg-brandHover disabled:opacity-60"
                disabled={scanState === 'scanning'}
                onClick={() => void runCapture()}
              >
                {scanState === 'failed' ? 'Try again' : 'Scan again'}
              </button>
            </div>
            <div
              className={clsx(
                'mt-4 rounded-card border border-dashed px-4 py-3.5 text-[12px] transition-colors',
                dropActive
                  ? 'border-brand bg-tintPrimary text-textHi'
                  : 'border-borderSubtle text-textLow',
              )}
            >
              No screen permission? Drop a screenshot anywhere in this window, or paste it (⌘V)
              <button
                type="button"
                className="mt-1.5 block w-full text-center font-medium text-brand hover:underline"
                onClick={() => fileInputRef.current?.click()}
              >
                or choose an image…
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importScreenshot(file);
                  event.target.value = '';
                }}
              />
            </div>
          </div>
        )}

        {step === 'approve' && capture && (
          <div className="text-center">
            <h2 className="text-[18px] font-semibold text-textHiStrong">
              Approve in Otterin Connector
            </h2>
            <p className="mt-2 text-[13px] leading-5 text-textMid">
              Check that the fingerprint below matches what{' '}
              {capture.computerName ?? 'the Connector'} shows, then approve the pairing there.
            </p>
            <div className="mt-5 flex gap-3">
              <BigFingerprint label="This Mac" value={capture.deviceKeyFingerprint} highlight />
              <BigFingerprint label="Connector" value={capture.bridgeKeyFingerprint} />
            </div>
            {submitState === 'waiting' ? (
              <div className="mt-6 flex items-center justify-center text-[13px] text-textMid">
                <span className="mr-2 h-2 w-2 animate-otterin-pulse rounded-dot bg-brand" />
                Waiting for approval{capture.computerName ? ` on ${capture.computerName}` : ''}…
              </div>
            ) : (
              <div className="mt-5">
                <div className="rounded-card border border-border bg-surface1 px-4 py-3 text-[12px] leading-5 text-textMid">
                  {submitState === 'denied' &&
                    'The pairing was denied in Otterin Connector. Scan again to restart.'}
                  {submitState === 'expired' &&
                    'The pairing offer expired before it was approved. Scan again for a fresh QR.'}
                  {submitState === 'error' &&
                    'Something went wrong while pairing. Scan again to retry.'}
                </div>
                <button
                  type="button"
                  className="mt-3 w-full rounded-card bg-brand py-2.5 text-[13px] font-medium text-textAlwaysWhite hover:bg-brandHover"
                  onClick={() => {
                    setCapture(null);
                    setStep('scan');
                    void runCapture();
                  }}
                >
                  Scan again
                </button>
              </div>
            )}
          </div>
        )}

        {step === 'grants' && (
          <div className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-tintGreen">
              <Icon name="check" size={22} className="text-finished" />
            </div>
            <h2 className="mt-4 text-[18px] font-semibold text-textHiStrong">
              Paired with {pairedName ?? 'your computer'}
            </h2>
            <p className="mt-2 text-[13px] leading-5 text-textMid">
              These grants control what this Mac can do. Change them any time in Otterin Connector
              — anything off here stays read-only or hidden.
            </p>
            <div className="mt-5 space-y-2 text-left">
              {grantRows.map(([label, enabled, hint]) => (
                <div
                  key={label}
                  className="flex items-center rounded-card border border-borderSubtle bg-surface2 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-textHi">{label}</div>
                    <div className="mt-0.5 text-[11px] text-textLow">{hint}</div>
                  </div>
                  {enabled === undefined ? (
                    <span className="ml-3 text-[11px] text-textLow">…</span>
                  ) : (
                    <span
                      className={clsx(
                        'ml-3 rounded-chip px-2.5 py-1 text-[11px] font-medium',
                        enabled ? 'bg-tintGreen text-finished' : 'bg-tintSecondary text-textLow',
                      )}
                    >
                      {enabled ? 'On' : 'Off — enable in Connector'}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-6 w-full rounded-card bg-brand py-3 text-[14px] font-medium text-textAlwaysWhite hover:bg-brandHover"
              onClick={() => {
                store.poke();
                onDone();
              }}
            >
              Start using Otterin
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="text-center">
            <h2 className="text-[18px] font-semibold text-textHiStrong">All set</h2>
            <button
              type="button"
              className="mt-6 w-full rounded-card bg-brand py-3 text-[14px] font-medium text-textAlwaysWhite"
              onClick={onDone}
            >
              Open Otterin
            </button>
          </div>
        )}
        <div className="mt-8">
          <StepDots step={step} />
        </div>
      </div>
    </div>
  );
}
