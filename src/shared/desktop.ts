/** Versioned handshake between the macOS shell and the local Relay service. */
export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export interface RelayReadyEnvelope {
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  pid: number;
  port: number;
  url: string;
  token: string;
}

export type AppChannel = "stable" | "beta" | "development";

export interface AppInfo {
  version: string;
  build: string;
  channel: AppChannel;
  desktop: "macos-arm64";
}
