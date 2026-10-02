/**
 * What the control plane needs from the VM layer. The real implementation
 * is an adapter over @invisible-dots/vm-manager (apps/api/src/vm-driver.ts);
 * tests use the in-process fakes of `./testing.js`.
 */
import type {
  AgentStateAnswer,
  BrowserIdentity,
  BrowserIdentityListAnswer,
  ComputerResources,
  CreateBrowserIdentityRequest,
  DotRuntimeConfig,
  HealthAnswer,
  InboundEvent,
  OutboundEvent,
  SystemAnswer,
  VmState,
} from "@invisible-dots/shared";

/**
 * The guest routes the control plane calls (sections 5.2 and 5.3). The
 * method names and shapes are those of vm-manager's GuestClient, which
 * satisfies this interface as it is. Failed calls throw an error carrying a
 * numeric `status` (0 when the guest could not be reached) and, when the
 * guest sent one, its `{ error }` code as `code`.
 */
export interface GuestApi {
  health(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HealthAnswer>;
  system(): Promise<SystemAnswer>;
  pushSecrets(openrouterApiKey: string): Promise<void>;
  putConfig(config: DotRuntimeConfig): Promise<void>;
  postEvent(event: InboundEvent): Promise<unknown>;
  state(): Promise<AgentStateAnswer>;
  listBrowserIdentities(): Promise<BrowserIdentityListAnswer>;
  createBrowserIdentity(body: CreateBrowserIdentityRequest): Promise<BrowserIdentity>;
  getBrowserIdentity(id: string): Promise<BrowserIdentity>;
  deleteBrowserIdentity(id: string): Promise<void>;
  prepareSleep(timeoutMs?: number): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  /**
   * The outbound event stream after `after`. It reconnects by itself on
   * network errors and ends only when `signal` aborts or it hits an error
   * that waiting cannot fix (a refused token).
   */
  events(options: { after?: number; signal?: AbortSignal }): AsyncIterable<OutboundEvent>;
}

export interface ComputerSpecInput {
  dotId: string;
  cid: number;
  /** The Dot token in clear. */
  token: string;
  resources: ComputerResources;
}

export interface CreatedComputer {
  domainName: string;
  /** The golden image the overlay is backed by; recorded, because it can never change for this disk. */
  goldenImage: string;
  runtimeImage: string;
}

export interface StartedComputer {
  /** The CID the VM runs with; differs from the requested one when that was taken on the host. */
  cid: number;
  runtimeImage: string;
  alreadyRunning: boolean;
}

export interface DomainState {
  /** Whether libvirt knows the domain. */
  defined: boolean;
  state: VmState;
  /** What libvirt reported, for logs and error messages. */
  detail: string | null;
}

export interface ComputerDriver {
  /** Overlay, seed and domain definition (section 9.4 up to `virsh define`). Safe to retry. */
  create(spec: ComputerSpecInput): Promise<CreatedComputer>;
  /** Start the VM and its bridge; `reservedCids` are the CIDs other Dots hold. */
  start(spec: ComputerSpecInput & { goldenImage: string }, reservedCids: readonly number[]): Promise<StartedComputer>;
  /** Graceful shutdown, forced after the grace period, then the bridge is stopped (section 9.5). */
  stop(dotId: string): Promise<{ forced: boolean }>;
  reboot(dotId: string): Promise<void>;
  /** Remove the domain, its definition and the VM directory with the disk. */
  destroy(dotId: string): Promise<void>;
  state(dotId: string): Promise<DomainState>;
  /** Make sure the bridge of a VM that is already running is up (after a control plane restart). */
  attach(dotId: string, cid: number): Promise<void>;
  guest(dotId: string, token: string): GuestApi;
  /** Release host resources owned by this process (bridges). VMs keep running. */
  close(): Promise<void>;
}

/** The HTTP status a failed guest call carried, or 0 when the guest was not reached. */
export function guestErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : 0;
}

/** The `{ error }` code of a failed guest call, when there was one. */
export function guestErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && !/^E[A-Z]+$/.test(code) ? code : undefined;
}
