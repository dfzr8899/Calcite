import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.calcite.notes',
  appName: 'Calcite',
  webDir: 'dist',
  plugins: { CapacitorHttp: { enabled: true }, SystemBars: { insetsHandling: 'disable' } }
};

export default config;
