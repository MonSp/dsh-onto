import { OntoRuntime } from '@dsh-onto/runtime'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Minimal TypertRemoteService-compatible ctx: super(ctx, serviceKey) needs cordis Service shape.
// Real construction goes through cordis; here we only assert the class is exported and has remote methods.
assert.equal(typeof OntoRuntime, 'function')
const proto = OntoRuntime.prototype
for (const m of [
  'remoteExportListScenarios',
  'remoteExportRunScenario',
  'remoteExportListRuns',
  'remoteExportShowRun',
  'remoteExportCompareRuns',
  'remoteExportExportAudit',
  'remoteExportReviewChain',
  'remoteExportListExperiences',
  'remoteExportShowExperience',
  'remoteExportReviewExperience',
]) {
  assert.equal(typeof proto[m], 'function', m)
}
console.log('OntoRuntime remote methods OK:', 10)