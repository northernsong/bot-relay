/**
 * Agent2Agent protocol 1.0, specification patch 1.0.1.
 * https://a2a-protocol.org/latest/specification/
 * https://github.com/a2aproject/A2A/releases/tag/v1.0.1
 *
 * JSON field names and enum strings follow the normative proto JSON mapping.
 */
export const A2A_SPEC = '1.0.1';
export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_GATEWAY_ID = 'a2a';

export const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthenticated: -32000,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotSupported: -32003,
  unsupported: -32004,
  contentType: -32005,
  version: -32009,
} as const;
