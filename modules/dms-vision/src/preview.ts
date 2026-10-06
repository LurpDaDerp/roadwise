// The C2 setup preview view (ios/DmsPreviewView.swift, android/.../DmsPreviewView.kt), reached from JS. Native
// draws the running camera into it ONLY while the latest policy has both `setupMode` and `previewAllowed`
// (README §6): outside the parked setup the view is blank. Nothing is captured, stored or sent by a preview.
// Resolved lazily and never throwing: without the native module (Jest, Expo Go, web) there is no view (null).
import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

let cached: ComponentType<ViewProps> | null | undefined;

/** The native preview component, or null where the module is not linked. */
export function previewView(): ComponentType<ViewProps> | null {
  if (cached !== undefined) return cached;
  try {
    cached = requireNativeViewManager<ViewProps>('DmsVision');
  } catch {
    cached = null;
  }
  return cached;
}
