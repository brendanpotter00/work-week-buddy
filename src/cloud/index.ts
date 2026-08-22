/**
 * `src/cloud/` — setting the cloud half up, from inside the app.
 *
 * Everything `scripts/bringup-cloud.sh` does, over the Cloudflare REST API,
 * with no wrangler, no `wrangler login` and no terminal. The shell script stays
 * as the fallback; this is the path a person uses.
 *
 * Layered like `src/sync/`: no `electron` import anywhere in here, so the whole
 * thing is exercised in plain Node against a fake Cloudflare. `src/main/` owns
 * the keychain, the machine id and the IPC.
 */
export {
  CLOUDFLARE_API_BASE,
  createCloudflareApi,
  toSubdomainLabel,
  workersDevUrl,
  type CloudScopes,
  type CloudflareAccount,
  type CloudflareApi,
  type CloudflareApiConfig,
  type D1DatabaseSummary,
  type ReadBinding,
  type ScopeState,
  type WorkerBinding,
  type WorkerUpload,
} from "./api";
export {
  CloudflareApiError,
  CloudflareNetworkError,
  PERMISSION,
  describeCloudError,
  redactSecrets,
  type PermissionName,
} from "./errors";
export {
  DEFAULT_DATABASE_NAME,
  DEFAULT_WORKER_NAME,
  STEP_LABEL,
  STEP_ORDER,
  buildBindings,
  findDatabase,
  probeCloud,
  readEnrolledMachines,
  revokeMachine,
  runCloudSetup,
  type BringupDeps,
  type CloudDeploymentState,
  type CloudProbe,
  type CloudSetupOutcome,
  type CloudSetupProgress,
  type CloudSetupRequest,
  type CloudStep,
  type CloudStepId,
  type EnrolledMachineRow,
  type StepState,
} from "./bringup";
export { TOKEN_PAGE_URL, tokenCreateUrl } from "./token-url";
export {
  WORKER_BUNDLE,
  WORKER_COMPATIBILITY_DATE,
  WORKER_INPUTS_SHA256,
  WORKER_MAIN_MODULE,
  WORKER_NAME,
  WORKER_SCHEMA_SQL,
} from "./worker-bundle.generated";
