export interface ConnectionSlice {
  serverPort: string | null;
  serverBaseUrl: string | null;
  serverToken: string | null;
  serverMode: 'local' | 'remote' | 'web' | null;
  connected: boolean;
  setServerPort: (port: string) => void;
  setServerBaseUrl: (baseUrl: string | null) => void;
  setServerToken: (token: string) => void;
  setServerMode: (mode: 'local' | 'remote' | 'web' | null) => void;
  setConnected: (connected: boolean) => void;
}

export const createConnectionSlice = (
  set: (partial: Partial<ConnectionSlice>) => void
): ConnectionSlice => ({
  serverPort: null,
  serverBaseUrl: null,
  serverToken: null,
  serverMode: null,
  connected: false,
  setServerPort: (port) => set({ serverPort: port }),
  setServerBaseUrl: (baseUrl) => set({ serverBaseUrl: baseUrl }),
  setServerToken: (token) => set({ serverToken: token }),
  setServerMode: (mode) => set({ serverMode: mode }),
  setConnected: (connected) => set({ connected }),
});
