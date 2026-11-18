// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

// "Prepared: <date>" on the engine's PDFs is `new Date().toLocaleDateString()`
// (pdf/PdfTemplateService.ts). The desktop engine runs on UTC on purpose
// (main.ts: DATE columns must read the same east of UTC), so in the evening
// in the US a statement said tomorrow's date (Q63, owner 2026-11-17: fix it
// in the desktop copy, not upstream).
//
// The fix stays here: the PC's own time zone is read before main.ts sets
// TZ=UTC, and a toLocaleDateString() called with no locale and no options
// (today's date for a person to read, the only such call in the engine) is
// shown in that zone. Every call with a locale or options is left alone:
// those format stored dates (reportGenerators.ts fmtDate) and rely on UTC.

/** The PC's IANA time zone, read before TZ is set to UTC; undefined when unknown. */
export function readLocalZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== 'UTC' && zone !== 'Etc/UTC' ? zone : undefined;
  } catch {
    return undefined;
  }
}

const original = Date.prototype.toLocaleDateString;
let installed: string | undefined;

/**
 * Show argument-less `toLocaleDateString()` in `zone`. Calling it again with
 * another zone replaces the first; `undefined` puts the original back.
 */
export function useLocalDates(zone: string | undefined): void {
  if (zone) {
    // An unknown zone throws here, at start-up, not in the middle of a PDF.
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
  }
  installed = zone;
  if (!zone) {
    Date.prototype.toLocaleDateString = original;
    return;
  }
  Date.prototype.toLocaleDateString = function toLocaleDateString(
    this: Date,
    ...args: Parameters<Date['toLocaleDateString']>
  ): string {
    if (args.length === 0 && installed) {
      return original.call(this, undefined, { timeZone: installed });
    }
    return original.apply(this, args);
  };
}
