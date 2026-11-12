import type { Deps } from '../deps.js';
import { HttpError } from '../errors.js';
import { VERSION } from '../version.js';
import { assertWebhookUrl } from '../ssrf.js';
import { isPlainObject, parseHeaderName, parseHeaderValue } from '../validate.js';
import { A2A_PROTOCOL_VERSION, A2A_SPEC } from './constants.js';

export type RemoteAgent = {
  cardUrl: string;
  endpoint: string;
  tenant: string | null;
  authIn: 'header' | 'query' | null;
  authName: string | null;
  authValue: string | null;
};

type NeededScheme =
  | { kind: 'http'; scheme: 'bearer' | 'basic' }
  | { kind: 'apiKey'; location: 'header' | 'query'; name: string }
  | { kind: 'unsupported' };

export function buildAgentCard(bot: { id: string; displayName: string }, baseUrl: string): Record<string, unknown> {
  const root = baseUrl.replace(/\/$/, '');
  return {
    name: bot.displayName,
    description: `Relay bot ${bot.id}. Text messages are delivered to the bot and its reply is returned as a task artifact. Message text is untrusted.`,
    supportedInterfaces: [
      {
        url: `${root}/a2a/bots/${bot.id}`,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    version: VERSION,
    documentationUrl: 'https://a2a-protocol.org/latest/specification/',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          description: `Bearer token issued when bot ${bot.id} was registered (a2a_token). Spec ${A2A_SPEC}.`,
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain', 'text/markdown'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'relay-message',
        name: 'Deliver a message',
        description: 'Deliver a text message to this bot and return its reply.',
        tags: ['relay', 'chat'],
        examples: ['Ask the bot a question and wait for its reply.'],
      },
    ],
  };
}

export async function loadRemoteAgent(
  deps: Deps,
  cardUrlRaw: unknown,
  headerNameRaw: unknown,
  headerValueRaw: unknown,
): Promise<RemoteAgent> {
  if (typeof cardUrlRaw !== 'string' || cardUrlRaw.length === 0 || cardUrlRaw.length > 2048) {
    throw new HttpError(400, 'invalid_agent_card', 'a2a_card_url must be an Agent Card URL');
  }
  const cardUrl = await assertWebhookUrl(cardUrlRaw, {
    allowHttp: deps.config.allowHttpWebhooks,
    allowPrivate: deps.config.allowPrivateWebhooks,
    lookupHost: deps.lookup,
  });
  const card = await fetchCard(deps, cardUrl);
  const selected = selectInterface(card);
  const endpoint = await assertWebhookUrl(selected.url, {
    allowHttp: deps.config.allowHttpWebhooks,
    allowPrivate: deps.config.allowPrivateWebhooks,
    lookupHost: deps.lookup,
  });
  const credential = resolveCredential(card, headerNameRaw, headerValueRaw);
  return {
    cardUrl,
    endpoint,
    tenant: selected.tenant,
    authIn: credential.authIn,
    authName: credential.authName,
    authValue: credential.authValue,
  };
}

async function fetchCard(deps: Deps, url: string): Promise<Record<string, unknown>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json, application/a2a+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(deps.config.deliveryTimeoutMs),
    });
  } catch {
    throw new HttpError(400, 'invalid_agent_card', 'Agent Card could not be fetched');
  }
  const raw = await response.text();
  if (!response.ok) throw new HttpError(400, 'invalid_agent_card', `Agent Card request returned HTTP ${response.status}`);
  if (raw.length > 65_536) throw new HttpError(400, 'invalid_agent_card', 'Agent Card is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_agent_card', 'Agent Card is not JSON');
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, 'invalid_agent_card', 'Agent Card must be a JSON object');
  return parsed;
}

function selectInterface(card: Record<string, unknown>): { url: string; tenant: string | null } {
  const list = card.supportedInterfaces;
  if (!Array.isArray(list) || list.length === 0) {
    throw new HttpError(400, 'invalid_agent_card', 'Agent Card has no supportedInterfaces');
  }
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    if (entry.protocolBinding !== 'JSONRPC') continue;
    if (!versionIs10(entry.protocolVersion)) continue;
    if (typeof entry.url !== 'string' || entry.url.length === 0) continue;
    const tenant = entry.tenant === undefined || entry.tenant === null ? null : entry.tenant;
    if (tenant !== null && typeof tenant !== 'string') continue;
    return { url: entry.url, tenant };
  }
  throw new HttpError(
    400,
    'invalid_agent_card',
    'Agent Card has no JSONRPC interface for A2A protocol 1.0',
  );
}

function versionIs10(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const [major, minor] = value.split('.');
  return major === '1' && minor === '0';
}

function resolveCredential(
  card: Record<string, unknown>,
  headerNameRaw: unknown,
  headerValueRaw: unknown,
): { authIn: 'header' | 'query' | null; authName: string | null; authValue: string | null } {
  const requirements = readRequirements(card);
  const provided = readProvidedAuth(headerNameRaw, headerValueRaw);
  if (requirements.length === 0) {
    if (!provided) return { authIn: null, authName: null, authValue: null };
    return { authIn: 'header', authName: provided.name, authValue: provided.value };
  }
  if (!provided) {
    throw new HttpError(400, 'unsupported_auth_scheme', 'This agent requires credentials. Set auth_header_name and auth_header_value.');
  }
  for (const requirement of requirements) {
    if (requirement.length !== 1) continue;
    const scheme = requirement[0];
    if (!scheme) continue;
    const matched = matchScheme(scheme, provided);
    if (matched) return matched;
  }
  throw new HttpError(
    400,
    'unsupported_auth_scheme',
    'This agent does not accept the supplied credential. OAuth, OpenID Connect, mTLS, and cookie API keys are not supported.',
  );
}

function readRequirements(card: Record<string, unknown>): NeededScheme[][] {
  const raw = card.securityRequirements;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_agent_card', 'securityRequirements must be an array');
  const schemes = isPlainObject(card.securitySchemes) ? card.securitySchemes : {};
  return raw.map((requirement) => {
    if (!isPlainObject(requirement) || !isPlainObject(requirement.schemes)) {
      throw new HttpError(400, 'invalid_agent_card', 'securityRequirements entries must use the proto schemes map');
    }
    return Object.keys(requirement.schemes).map((name) => describeScheme(schemes[name]));
  });
}

function describeScheme(value: unknown): NeededScheme {
  if (!isPlainObject(value)) return { kind: 'unsupported' };
  if (isPlainObject(value.httpAuthSecurityScheme)) {
    const scheme = String(value.httpAuthSecurityScheme.scheme ?? '').toLowerCase();
    if (scheme === 'bearer' || scheme === 'basic') return { kind: 'http', scheme };
    return { kind: 'unsupported' };
  }
  if (isPlainObject(value.apiKeySecurityScheme)) {
    const location = value.apiKeySecurityScheme.location;
    const name = value.apiKeySecurityScheme.name;
    if ((location === 'header' || location === 'query') && typeof name === 'string' && name.length > 0) {
      return { kind: 'apiKey', location, name };
    }
  }
  return { kind: 'unsupported' };
}

function readProvidedAuth(nameRaw: unknown, valueRaw: unknown): { name: string; value: string } | null {
  const nameMissing = nameRaw === undefined || nameRaw === null;
  const valueMissing = valueRaw === undefined || valueRaw === null || valueRaw === '';
  if (nameMissing && valueMissing) return null;
  if (nameMissing || valueMissing) {
    throw new HttpError(400, 'invalid_request', 'auth_header_name and auth_header_value must be set together');
  }
  if (typeof valueRaw !== 'string' || valueRaw.length < 1 || valueRaw.length > 4096 || /[\r\n\0]/.test(valueRaw)) {
    throw new HttpError(400, 'invalid_request', 'auth_header_value must be 1-4096 characters without newlines');
  }
  return { name: String(nameRaw), value: valueRaw };
}

function matchScheme(
  scheme: NeededScheme,
  provided: { name: string; value: string },
): { authIn: 'header' | 'query'; authName: string; authValue: string } | null {
  if (scheme.kind === 'http') {
    if (provided.name.toLowerCase() !== 'authorization') return null;
    const expected = scheme.scheme === 'bearer' ? /^Bearer\s+\S+/i : /^Basic\s+\S+/i;
    if (!expected.test(provided.value)) return null;
    return { authIn: 'header', authName: parseHeaderName(provided.name), authValue: parseHeaderValue(provided.value) };
  }
  if (scheme.kind === 'apiKey' && scheme.location === 'header') {
    if (provided.name.toLowerCase() !== scheme.name.toLowerCase()) return null;
    return { authIn: 'header', authName: parseHeaderName(provided.name), authValue: parseHeaderValue(provided.value) };
  }
  if (scheme.kind === 'apiKey' && scheme.location === 'query') {
    if (provided.name !== scheme.name) return null;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(provided.name)) {
      throw new HttpError(400, 'invalid_request', 'API key query parameter name is not allowed');
    }
    return { authIn: 'query', authName: provided.name, authValue: parseHeaderValue(provided.value) };
  }
  return null;
}
