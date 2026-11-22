import {Capacitor} from '@capacitor/core';
import {electronAdapter} from './electron-adapter.js';
import {browserAdapter} from './browser-adapter.js';

export const platform=electronAdapter()??(Capacitor.isNativePlatform()?
  (await import('./capacitor-adapter.js')).capacitorAdapter():browserAdapter());
