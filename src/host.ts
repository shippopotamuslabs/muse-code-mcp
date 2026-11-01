import {
  MspError,
  spawnMspConnection,
  type Connection,
  type ExitClassification,
  type SpawnedMspConnection,
} from "@muse-code/sdk";

export interface HostPosture {
  workspace: string;
  contributorMode: boolean;
  preset?: string;
  trustWorkspace: boolean;
}

export interface HostFrame {
  method: string;
  params?: unknown;
}

export interface HostRequest {
  method: string;
  params?: unknown;
}

/** Pool key: one warm host per workspace and host-lifetime posture. */
export function postureKey(posture: HostPosture): string {
  return JSON.stringify([
    posture.workspace,
    posture.contributorMode,
    posture.preset ?? "",
    posture.trustWorkspace,
  ]);
}

export function hostArgs(posture: HostPosture): string[] {
  const args = ["serve", "--contributor-mode", posture.contributorMode ? "on" : "off"];
  if (posture.trustWorkspace) args.push("--trust-workspace");
  if (posture.preset) args.push("--preset", posture.preset);
  return args;
}

export class MuseHost {
  readonly key: string;
  readonly connection: Connection;
  readonly initializeResult: SpawnedMspConnection["initializeResult"];
  readonly fingerprintWarning?: string;
  readonly posture: HostPosture;
  private dead = false;
  private readonly spawned: SpawnedMspConnection;

  private constructor(posture: HostPosture, spawned: SpawnedMspConnection) {
    this.posture = posture;
    this.key = postureKey(posture);
    this.spawned = spawned;
    this.connection = spawned.connection;
    this.initializeResult = spawned.initializeResult;
    this.fingerprintWarning = spawned.fingerprintWarning?.message;
  }

  static async start(options: {
    bin: string;
    posture: HostPosture;
    env: NodeJS.ProcessEnv;
    onFrame: (frame: HostFrame) => void;
    onExit: (host: MuseHost, exit: ExitClassification) => void;
    shutdownTimeoutMs?: number;
  }): Promise<MuseHost> {
    const handshake = spawnMspConnection({
      command: options.bin,
      args: hostArgs(options.posture),
      cwd: options.posture.workspace,
      env: options.env,
      ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    });
    handshake.onNotification((notification) => {
      options.onFrame({ method: notification.method, params: notification.params });
    });
    handshake.onServerRequest(async (request) => {
      if (request.method === "userInput/request") {
        options.onFrame({ method: "userInput/requested", params: request.params });
        return {};
      }
      if (request.method === "approval/request") {
        options.onFrame({ method: "approval/request", params: request.params });
        return {};
      }
      throw new MspError({
        code: -32601,
        message: `method not found: ${request.method}`,
        data: { kind: "methodNotFound", retryable: false },
      });
    });
    const spawned = await handshake.initialize({
      clientInfo: { name: "muse_mcp", version: "0.1.0" },
      capabilities: { experimentalApi: true, userInputDialogs: true },
    });
    const host = new MuseHost(options.posture, spawned);
    void spawned.child.exit.then((exit) => {
      if (host.dead) return;
      host.dead = true;
      options.onExit(host, exit);
    });
    return host;
  }

  get isDead(): boolean {
    return this.dead;
  }

  async close(): Promise<void> {
    this.dead = true;
    await this.spawned.close();
  }
}
