/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accessRequests from '../accessRequests.js';
import type * as agents from '../agents.js';
import type * as baselineActions from '../baselineActions.js';
import type * as charters from '../charters.js';
import type * as config from '../config.js';
import type * as connectionEvents from '../connectionEvents.js';
import type * as corrections from '../corrections.js';
import type * as coworker from '../coworker.js';
import type * as credentialCryptoActions from '../credentialCryptoActions.js';
import type * as credentials from '../credentials.js';
import type * as crons from '../crons.js';
import type * as devAuth from '../devAuth.js';
import type * as docPages from '../docPages.js';
import type * as docSources from '../docSources.js';
import type * as docSyncActions from '../docSyncActions.js';
import type * as documentationDiscovery from '../documentationDiscovery.js';
import type * as documentationDiscoveryActions from '../documentationDiscoveryActions.js';
import type * as evaluation from '../evaluation.js';
import type * as eventLog from '../eventLog.js';
import type * as events from '../events.js';
import type * as exportActions from '../exportActions.js';
import type * as handoverFence from '../handoverFence.js';
import type * as intakeActions from '../intakeActions.js';
import type * as intakeIdentity from '../intakeIdentity.js';
import type * as intakeSeed from '../intakeSeed.js';
import type * as managerChannelActions from '../managerChannelActions.js';
import type * as managerQuestions from '../managerQuestions.js';
import type * as managerTransfers from '../managerTransfers.js';
import type * as mcpOauth from '../mcpOauth.js';
import type * as mcpOauthActions from '../mcpOauthActions.js';
import type * as memoryProjection from '../memoryProjection.js';
import type * as metrics from '../metrics.js';
import type * as migrations from '../migrations.js';
import type * as mock from '../mock.js';
import type * as mockSeed from '../mockSeed.js';
import type * as onboarding from '../onboarding.js';
import type * as oneToOne from '../oneToOne.js';
import type * as organisationConnections from '../organisationConnections.js';
import type * as orientationActions from '../orientationActions.js';
import type * as orientationData from '../orientationData.js';
import type * as ownership from '../ownership.js';
import type * as probeActions from '../probeActions.js';
import type * as reset from '../reset.js';
import type * as retirements from '../retirements.js';
import type * as revocationEvaluation from '../revocationEvaluation.js';
import type * as revocationEvaluationActions from '../revocationEvaluationActions.js';
import type * as roster from '../roster.js';
import type * as sandboxLease from '../sandboxLease.js';
import type * as seed from '../seed.js';
import type * as skillActions from '../skillActions.js';
import type * as skillAdoption from '../skillAdoption.js';
import type * as skillAuthorPrompt from '../skillAuthorPrompt.js';
import type * as skillAuthoringClaim from '../skillAuthoringClaim.js';
import type * as skillAuthoringRecord from '../skillAuthoringRecord.js';
import type * as skillAuthoringRun from '../skillAuthoringRun.js';
import type * as skillControls from '../skillControls.js';
import type * as skillProposal from '../skillProposal.js';
import type * as skillRegistration from '../skillRegistration.js';
import type * as skillSandboxCheck from '../skillSandboxCheck.js';
import type * as skillVersions from '../skillVersions.js';
import type * as skills from '../skills.js';
import type * as slackProvisionActions from '../slackProvisionActions.js';
import type * as sourceRevocation from '../sourceRevocation.js';
import type * as sourceRevocationActions from '../sourceRevocationActions.js';
import type * as storedVerification from '../storedVerification.js';
import type * as surfaceActions from '../surfaceActions.js';
import type * as surfaceReopen from '../surfaceReopen.js';
import type * as surfaces from '../surfaces.js';
import type * as transferAcceptance from '../transferAcceptance.js';
import type * as transferDepartures from '../transferDepartures.js';
import type * as transferInFlight from '../transferInFlight.js';
import type * as transferNotice from '../transferNotice.js';
import type * as transferPreview from '../transferPreview.js';
import type * as voice from '../voice.js';
import type * as waitingWork from '../waitingWork.js';
import type * as work from '../work.js';
import type * as workActions from '../workActions.js';
import type * as workLoop from '../workLoop.js';
import type * as workspace from '../workspace.js';

import type { ApiFromModules, FilterApi, FunctionReference } from 'convex/server';

declare const fullApi: ApiFromModules<{
  accessRequests: typeof accessRequests;
  agents: typeof agents;
  baselineActions: typeof baselineActions;
  charters: typeof charters;
  config: typeof config;
  connectionEvents: typeof connectionEvents;
  corrections: typeof corrections;
  coworker: typeof coworker;
  credentialCryptoActions: typeof credentialCryptoActions;
  credentials: typeof credentials;
  crons: typeof crons;
  devAuth: typeof devAuth;
  docPages: typeof docPages;
  docSources: typeof docSources;
  docSyncActions: typeof docSyncActions;
  documentationDiscovery: typeof documentationDiscovery;
  documentationDiscoveryActions: typeof documentationDiscoveryActions;
  evaluation: typeof evaluation;
  eventLog: typeof eventLog;
  events: typeof events;
  exportActions: typeof exportActions;
  handoverFence: typeof handoverFence;
  intakeActions: typeof intakeActions;
  intakeIdentity: typeof intakeIdentity;
  intakeSeed: typeof intakeSeed;
  managerChannelActions: typeof managerChannelActions;
  managerQuestions: typeof managerQuestions;
  managerTransfers: typeof managerTransfers;
  mcpOauth: typeof mcpOauth;
  mcpOauthActions: typeof mcpOauthActions;
  memoryProjection: typeof memoryProjection;
  metrics: typeof metrics;
  migrations: typeof migrations;
  mock: typeof mock;
  mockSeed: typeof mockSeed;
  onboarding: typeof onboarding;
  oneToOne: typeof oneToOne;
  organisationConnections: typeof organisationConnections;
  orientationActions: typeof orientationActions;
  orientationData: typeof orientationData;
  ownership: typeof ownership;
  probeActions: typeof probeActions;
  reset: typeof reset;
  retirements: typeof retirements;
  revocationEvaluation: typeof revocationEvaluation;
  revocationEvaluationActions: typeof revocationEvaluationActions;
  roster: typeof roster;
  sandboxLease: typeof sandboxLease;
  seed: typeof seed;
  skillActions: typeof skillActions;
  skillAdoption: typeof skillAdoption;
  skillAuthorPrompt: typeof skillAuthorPrompt;
  skillAuthoringClaim: typeof skillAuthoringClaim;
  skillAuthoringRecord: typeof skillAuthoringRecord;
  skillAuthoringRun: typeof skillAuthoringRun;
  skillControls: typeof skillControls;
  skillProposal: typeof skillProposal;
  skillRegistration: typeof skillRegistration;
  skillSandboxCheck: typeof skillSandboxCheck;
  skillVersions: typeof skillVersions;
  skills: typeof skills;
  slackProvisionActions: typeof slackProvisionActions;
  sourceRevocation: typeof sourceRevocation;
  sourceRevocationActions: typeof sourceRevocationActions;
  storedVerification: typeof storedVerification;
  surfaceActions: typeof surfaceActions;
  surfaceReopen: typeof surfaceReopen;
  surfaces: typeof surfaces;
  transferAcceptance: typeof transferAcceptance;
  transferDepartures: typeof transferDepartures;
  transferInFlight: typeof transferInFlight;
  transferNotice: typeof transferNotice;
  transferPreview: typeof transferPreview;
  voice: typeof voice;
  waitingWork: typeof waitingWork;
  work: typeof work;
  workActions: typeof workActions;
  workLoop: typeof workLoop;
  workspace: typeof workspace;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, 'public'>>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, 'internal'>>;

export declare const components: {};
