import * as numeric from './panelFamilyNumericReconciliation.js';
import * as constrained from './panelFamilyConstrainedPlanning.js';
import * as asyncCode from './panelFamilyAsyncCode.js';
import * as date from './panelFamilyDateTime.js';
import * as tenant from './panelFamilyTenantBoundReporting.js';
import * as governed from './panelFamilyGovernedContextDependentState.js';
import * as recovery from './panelFamilyRecoverWithoutReplaying.js';
import * as reuse from './panelFamilyReuseFirstToolSelection.js';

export const a0FamilyAdapters = new Map([numeric, constrained, asyncCode, date, tenant, governed, recovery, reuse].map(a => [a.FAMILY, a]));
