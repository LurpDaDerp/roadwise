import { useState } from 'react';

import { blockedDuringDrive } from '@/drive/leave';
import { Banner } from '@/ui';

import { exportMyData, type AccountDeps, type ExportResult } from './api';
import { settingsCopy } from './copy';
import { shareExport, type ExportShareOutcome } from './exportShare';

const copy = settingsCopy.account.export;

export interface ExportDeps {
  account?: AccountDeps;
  exportData?: () => Promise<ExportResult>;
  share?: (json: string) => Promise<ExportShareOutcome>;
  platform?: string;
}

export type ExportState = 'idle' | 'working' | 'saved' | 'offline' | 'too_many' | 'failed';

/** `account-export`, then the file goes to the share sheet (iOS) or a folder picker (Android). */
export function useExport(deps: ExportDeps = {}) {
  const [state, setState] = useState<ExportState>('idle');
  const run = async () => {
    if (state === 'working') return;
    // The share sheet and the Android folder picker open outside RoadWise: not during a drive.
    if (blockedDuringDrive()) return;
    setState('working');
    const r = await (deps.exportData ?? (() => exportMyData(deps.account)))();
    if (!r.ok) {
      setState(r.reason);
      return;
    }
    const outcome = await (deps.share ?? ((json: string) => shareExport(json)))(r.json);
    setState(outcome === 'failed' ? 'failed' : outcome === 'saved' ? 'saved' : 'idle');
  };
  return { state, run };
}

export function ExportMessage({ state }: { state: ExportState }) {
  if (state === 'saved') return <Banner testID="export-saved" tone="success" message={copy.saved} />;
  if (state === 'offline') return <Banner testID="export-offline" tone="info" message={copy.offline} />;
  if (state === 'too_many') return <Banner testID="export-too-many" tone="warning" message={copy.tooMany} />;
  if (state === 'failed') return <Banner testID="export-failed" tone="warning" message={copy.failed} />;
  return null;
}
